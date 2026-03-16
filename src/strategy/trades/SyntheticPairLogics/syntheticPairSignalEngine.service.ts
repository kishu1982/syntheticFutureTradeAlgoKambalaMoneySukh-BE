import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { isTradingAllowedForExchange } from 'src/common/utils/trading-time.util';
import { TelegramService } from 'src/telegram/telegram.service';

/*
===========================================================
SyntheticPairSignalEngineService
===========================================================

ROLE
-----
This service analyzes market state and generates
ENTRY signals for synthetic pair trades.

It does NOT manage exits.

DATA FLOW
---------
SyntheticPairTradeExecutionService
        ↓
syntheticPairMonitoringData.json
        ↓
Signal Engine reads JSON every 1 minute
        ↓
Evaluate signal conditions
        ↓
If valid signal:
   • mark tradeActive = true
   • set entryPrice
   • set entryTime
   • set tradeSide
        ↓
Update JSON
        ↓
Send Telegram alert


SIGNAL CONDITIONS
-----------------
Signals are triggered based on:

• new day high / low
• gap type (GAP_UP / GAP_DOWN / NO_GAP)
• first candle structure
• time conditions
• day range filter


ENTRY UPDATE
------------
When signal is generated:

tradeActive = true
tradeSide   = BUY | SELL
entryPrice  = currentPrice
entryTime   = timestamp
maxProfitSeen = 0


TELEGRAM ALERT
--------------
📢 SYNTHETIC SIGNAL
Symbol
Signal type
Market context


IMPORTANT
---------
Signal engine must NOT handle:

• stoploss
• vwap exit
• trailing exit

These are handled by:

SyntheticPairRmsService


EXECUTION LOOP
--------------
Runs every 1 seconds.


INPUT FILE
----------
syntheticPairMonitoringData.json


OUTPUT
------
Updates trade entry fields in JSON.
*/

@Injectable()
export class SyntheticPairSignalEngineService {
  private readonly logger = new Logger(SyntheticPairSignalEngineService.name);
  private lastObservedLevels = new Map<string, { high: number; low: number }>();
  private dayRangeBlockNotified = new Map<string, string>();
  private breakoutTriggered = new Set<string>(); // to avoid duplicate signals

  private readonly FILE_PATH = path.join(
    process.cwd(),
    'data',
    'syntheticPairData',
    'syntheticPairMonitoringData.json',
  );
  private thrashholdDivderFivedaysAvg = 0.66;

  //private signalState = new Map<string, boolean>();

  constructor(
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
  ) {}

  private getISTTime(): Date {
    return new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
  }

  private getISTDate(): string {
    const now = this.getISTTime();

    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');

    return `${y}-${m}-${d}`;
  }

  private timeToMinutes(time: string) {
    const t = time.split(' ')[1];
    const [h, m] = t.split(':').map(Number);

    return h * 60 + m;
  }

  private isBefore916(time: string) {
    return this.timeToMinutes(time) <= 9 * 60 + 16;
  }

  private isAfter930(time: string) {
    return this.timeToMinutes(time) >= 9 * 60 + 30;
  }

  @Interval(1000)
  async checkSignals() {
    try {
      if (!isTradingAllowedForExchange('NFO', this.configService)) {
        return;
      }

      if (!fs.existsSync(this.FILE_PATH)) return;

      const raw = fs.readFileSync(this.FILE_PATH, 'utf8');

      const json = JSON.parse(raw);

      if (json.date !== this.getISTDate()) return;

      const indices = json.indices;

      for (const token in indices) {
        const data = indices[token];

        await this.evaluateSignals(token, data);
      }
    } catch (err) {
      this.logger.error('Signal engine failed', err?.stack);
    }
  }

  // ------------------------------------------------
  // SIGNAL EVALUATION LOGIC
  // ------------------------------------------------
  private async evaluateSignals(token: string, d: any) {
    // to avoide signals duplicate
    if (this.breakoutTriggered.has(token)) return;
    // adding logic to track new highs and lows of the day
    const last = this.lastObservedLevels.get(token);

    let newHigh = false;
    let newLow = false;

    if (!last) {
      this.lastObservedLevels.set(token, {
        high: d.currentDayHigh,
        low: d.currentDayLow,
      });
      return;
    }

    const tolerance = Math.max(d.currentPrice * 0.0003, 8);
    // ~0.03% or minimum 8 points

    // BUY breakout detection
    if (
      d.currentPrice > last.high ||
      (d.currentDayHigh > last.high &&
        Math.abs(d.currentPrice - d.currentDayHigh) <= tolerance)
    ) {
      newHigh = true;
    }

    // SELL breakout detection
    if (
      d.currentPrice < last.low ||
      (d.currentDayLow < last.low &&
        Math.abs(d.currentPrice - d.currentDayLow) <= tolerance)
    ) {
      newLow = true;
    }

    if (newHigh && newLow) {
      this.logger.warn(`${d.symbol} conflicting breakout detected`);
      return;
    }

    // update stored levels
    this.lastObservedLevels.set(token, {
      high: Math.max(last.high, d.currentDayHigh),
      low: Math.min(last.low, d.currentDayLow),
    });

    // evaluate signals based on new highs/lows and time conditions
    const {
      exchange,
      symbol,
      gapType,
      openPrice,
      lastFiveDayAvgMovePct,
      currentDayMovePct,
      firstCandleHigh,
      firstCandleLow,
      firstCandleHighTime,
      firstCandleLowTime,
      currentDayHigh,
      currentDayLow,
      currentDayHighTime,
      currentDayLowTime,
    } = d;

    // ------------------------------------------------
    // IF TRADE SIGNAL ALREADY GIVEN THEN RETURN
    // Prevent new entry when trade already active.
    // ------------------------------------------------

    if (d.tradeActive) {
      this.logger.warn(`${symbol} trade already active`);
      return;
    }

    // ------------------------------------------------
    // DAY RANGE FILTER
    // ------------------------------------------------
    const netMovingAvg =
      lastFiveDayAvgMovePct * this.thrashholdDivderFivedaysAvg;
    if (currentDayMovePct > netMovingAvg) {
      const today = this.getISTDate();
      const notifyKey = `${token}_${today}`;

      this.logger.warn(
        `${symbol} signal blocked → DayMove ${currentDayMovePct}% > Avg5Day ${netMovingAvg}% after Division of ${lastFiveDayAvgMovePct} X ${this.thrashholdDivderFivedaysAvg}`,
      );

      if (!this.dayRangeBlockNotified.has(notifyKey)) {
        this.dayRangeBlockNotified.set(notifyKey, today);

        const message = `
⚠️ <b>SYNTHETIC SIGNAL MIGHT BE BLOCKED During day </b>

Symbol: ${symbol}
Token: ${token}

Reason:
Current Day Range exceeded 5 Day Average

Current Day Move: <b>${currentDayMovePct}%</b>
5 Day Avg Move: <b>${netMovingAvg} after Division of ${lastFiveDayAvgMovePct} X ${this.thrashholdDivderFivedaysAvg} %</b>

Signals disabled for today.

Time: ${new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
        })}
`;

        await this.telegramService.sendMessage(message);
      }

      return;
    }

    // day range filter end

    //const stateKey = `${token}`;

    // if (!this.signalState.has(stateKey)) {
    //   this.signalState.set(stateKey, false);
    // }

    // if (this.signalState.get(stateKey)) return;

    let signal: string | null = null;
    let signalType: string | null = null;

    // ------------------------------------------------
    // GUARD FOR VWAP IF MISSING
    // ------------------------------------------------

    if (!d.vwap || d.vwap === 0) {
      this.logger.warn(`${symbol} VWAP missing, entry blocked`);
      return;
    }

    // ------------------------------------------------
    // SIGNAL 1 SELL STRADDLE
    // ------------------------------------------------

    if (
      newLow &&
      gapType === 'GAP_DOWN' &&
      openPrice === firstCandleHigh &&
      firstCandleHigh === currentDayHigh &&
      this.isBefore916(firstCandleHighTime)
    ) {
      signal = 'EntrySignal1_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 2 SELL STRADDLE
    // ------------------------------------------------
    if (
      newLow &&
      gapType === 'GAP_DOWN' &&
      openPrice !== firstCandleHigh &&
      firstCandleHighTime === currentDayHighTime &&
      this.isBefore916(firstCandleHighTime)
    ) {
      signal = 'EntrySignal2_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 3 SELL STRADDLE
    // ------------------------------------------------

    if (newLow && gapType === 'NO_GAP' && this.isAfter930(currentDayLowTime)) {
      signal = 'EntrySignal3_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }
    // ------------------------------------------------
    // SIGNAL 1 BUY STRADDLE
    // ------------------------------------------------

    if (
      newHigh &&
      gapType === 'GAP_UP' &&
      openPrice === firstCandleLow &&
      firstCandleLow === currentDayLow &&
      this.isBefore916(firstCandleLowTime)
    ) {
      signal = 'EntrySignal1_BuyStraddle';
      signalType = 'BUY_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 2 BUY STRADDLE
    // ------------------------------------------------
    if (
      newHigh &&
      gapType === 'GAP_UP' &&
      openPrice !== firstCandleLow &&
      firstCandleLowTime === currentDayLowTime &&
      this.isBefore916(firstCandleLowTime)
    ) {
      signal = 'EntrySignal2_BuyStraddle';
      signalType = 'BUY_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 3 BUY STRADDLE
    // ------------------------------------------------

    if (
      newHigh &&
      gapType === 'NO_GAP' &&
      this.isAfter930(currentDayHighTime)
    ) {
      signal = 'EntrySignal3_BuyStraddle';
      signalType = 'BUY_STRADDLE';
    }

    // ------------------------------------------------
    // UNIVERSAL GAP RULES
    // ------------------------------------------------
    if (gapType === 'GAP_UP' && signalType === 'SELL_STRADDLE') {
      this.logger.warn(`${symbol} GAP UP → short blocked`);
      return;
    }

    if (gapType === 'GAP_DOWN' && signalType === 'BUY_STRADDLE') {
      this.logger.warn(`${symbol} GAP DOWN → long blocked`);
      return;
    }

    if (!signal) return;

    // adding token to this variable to avoid duplicate signals
    this.breakoutTriggered.add(token);

    //this.signalState.set(stateKey, true);

    this.logger.log(`${symbol} ${signal}`);
    // ADDING TRADE ENTRY LOGIC
    this.updateTradeEntry(token, signalType);

    // READ UPDATED DATA FOR MESSAGE in log and telegram
    const rawUpdated = fs.readFileSync(this.FILE_PATH, 'utf8');
    const jsonUpdated = JSON.parse(rawUpdated);
    const updatedTrade = jsonUpdated.indices[token];

    const entryPrice = updatedTrade?.entryPrice;
    const tradeSide = updatedTrade?.tradeSide;

    const message = `
📢 <b>SYNTHETIC TRADE SIGNAL</b>

Signal: <b>${signal}</b>
Type: <b>${signalType}</b>

Trade Side: <b>${tradeSide}</b>
Entry Price: <b>${entryPrice}</b>

Symbol: ${symbol}
Token: ${token}
Exchange: ${exchange}

Gap: ${gapType}

Open: ${openPrice}
FirstHigh: ${firstCandleHigh}
FirstLow: ${firstCandleLow}

CurrentHigh: ${currentDayHigh}
CurrentLow: ${currentDayLow}

Trigger: ${newHigh ? 'NEW HIGH' : 'NEW LOW'}

Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
`;
    await this.telegramService.sendMessage(message);
  }

  //--------------------------------
  // TRADE ENTRY LOGIC
  //--------------------------------
  private updateTradeEntry(token: string, signalType: string | null) {
    if (!signalType) return;

    try {
      if (!fs.existsSync(this.FILE_PATH)) return;

      const raw = fs.readFileSync(this.FILE_PATH, 'utf8');
      const json = JSON.parse(raw);

      const d = json.indices[token];
      const now = this.getISTTime();

      if (!d) return;

      // prevent duplicate entry
      if (d.tradeActive) return;

      d.tradeActive = true;
      d.tradeSide = signalType === 'BUY_STRADDLE' ? 'BUY' : 'SELL';
      d.entryPrice = d.currentPrice;
      // FIXED TIME
      d.entryTime = now.toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
      });
      d.maxProfitSeen = 0;

      fs.writeFileSync(this.FILE_PATH, JSON.stringify(json, null, 2));

      this.logger.log(`TRADE ENTRY ${d.symbol} ${d.tradeSide}`);
    } catch (err) {
      this.logger.error('Trade entry update failed', err?.stack);
    }
  }
}
