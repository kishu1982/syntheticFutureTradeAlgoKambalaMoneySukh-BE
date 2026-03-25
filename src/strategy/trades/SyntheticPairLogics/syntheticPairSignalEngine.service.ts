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
  private breakoutBuffer = 5; // points (you can tune this for getting near high and low)

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

    // BUY breakout detection (tightened)
    if (
      d.currentDayHigh > last.high &&
      d.currentPrice >= d.currentDayHigh - this.breakoutBuffer
    ) {
      newHigh = true;
    }

    // SELL breakout detection (tightened)
    if (
      d.currentDayLow < last.low &&
      d.currentPrice <= d.currentDayLow + this.breakoutBuffer
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

    // get now time
    const now = this.getISTTime();
    const nowStr = now
      .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
      .replace(',', '');

    const nowMin = this.timeToMinutes(nowStr);

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
    const sell1Conditions = {
      newLow,
      gapDown: gapType === 'GAP_DOWN',
      openEqFirstHigh: openPrice === firstCandleHigh,
      firstHighBefore916: this.isBeforeTime(currentDayHighTime, 9, 16),
      timeAfter916: nowMin >= 9 * 60 + 16,
    };

    this.logSignalDebug(symbol, 'SELL_SIGNAL_1', sell1Conditions, {
      openPrice,
      firstCandleHigh,
      currentDayHighTime,
      currentDayLow,
      lastLow: last.low,
    });

    if (Object.values(sell1Conditions).every(Boolean)) {
      signal = 'EntrySignal1_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 2 SELL STRADDLE
    // ------------------------------------------------

    const sell2Conditions = {
      newLow,
      gapDown: gapType === 'GAP_DOWN',
      //openEqFirstLow: openPrice === firstCandleLow,
      // firstLowBefore916: this.isBeforeTime(firstCandleLowTime, 9, 16),
      // firstHighBefore916: this.isBeforeTime(firstCandleHighTime, 9, 16),
      // DayLowBefore916: this.isBeforeTime(currentDayHighTime, 9, 16),
      DayHighBefore916: this.isBeforeTime(currentDayHighTime, 9, 16),
      timeAfter920: nowMin >= 9 * 60 + 20,
      highBelowPrevClose: currentDayHigh < d.prevClose,
    };

    this.logSignalDebug(symbol, 'SELL_SIGNAL_2', sell2Conditions);

    if (Object.values(sell2Conditions).every(Boolean)) {
      signal = 'EntrySignal2_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 3 SELL STRADDLE
    // ------------------------------------------------
    const sell3Conditions = {
      newLow,
      noGap: gapType === 'NO_GAP',
      highFormedBefore921: this.isBeforeTime(currentDayHighTime, 9, 21),
      timeAfter930: nowMin >= 9 * 60 + 30,
    };

    // this.logSignalDebug(symbol, 'SELL_SIGNAL_3', sell3Conditions, {
    //   currentDayHighTime,
    //   currentDayLow,
    //   currentPrice: d.currentPrice,
    // });
    this.logSignalDebug(symbol, 'SELL_SIGNAL_3', sell3Conditions, {
      currentDayHighTime,
      currentDayLow,
      currentPrice: d.currentPrice,
      diff: d.currentPrice - currentDayLow,
    });

    if (Object.values(sell3Conditions).every(Boolean)) {
      signal = 'EntrySignal3_SellStraddle';
      signalType = 'SELL_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 1 BUY STRADDLE
    // ------------------------------------------------

    const buy1Conditions = {
      newHigh,
      gapUp: gapType === 'GAP_UP',
      openEqFirstLow: openPrice === firstCandleLow,
      firstLowBefore916: this.isBeforeTime(currentDayLowTime, 9, 16),
      timeAfter916: nowMin >= 9 * 60 + 16,
    };

    this.logSignalDebug(symbol, 'BUY_SIGNAL_1', buy1Conditions, {
      openPrice,
      firstCandleLow,
      currentDayLowTime,
      currentDayHigh,
      lastHigh: last.high,
    });

    if (Object.values(buy1Conditions).every(Boolean)) {
      signal = 'EntrySignal1_BuyStraddle';
      signalType = 'BUY_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 2 BUY STRADDLE
    // ------------------------------------------------
    const buy2Conditions = {
      newHigh,
      gapUp: gapType === 'GAP_UP',
      // openEqFirstHigh: openPrice === firstCandleHigh,
      // firstHighBefore916: this.isBeforeTime(firstCandleHighTime, 9, 16),
      // firstLowBefore916: this.isBeforeTime(firstCandleLowTime, 9, 16),
      DayLowBefore916: this.isBeforeTime(currentDayLowTime, 9, 16),
      // DayHighBefore916: this.isBeforeTime(currentDayHighTime, 9, 16),
      timeAfter920: nowMin >= 9 * 60 + 20,
      lowAbovePrevClose: currentDayLow > d.prevClose,
    };

    this.logSignalDebug(symbol, 'BUY_SIGNAL_2', buy2Conditions);

    if (Object.values(buy2Conditions).every(Boolean)) {
      signal = 'EntrySignal2_BuyStraddle';
      signalType = 'BUY_STRADDLE';
    }

    // ------------------------------------------------
    // SIGNAL 3 BUY STRADDLE
    // ------------------------------------------------
    const buy3Conditions = {
      newHigh,
      noGap: gapType === 'NO_GAP',
      lowFormedBefore921: this.isBeforeTime(currentDayLowTime, 9, 21),
      timeAfter930: nowMin >= 9 * 60 + 30,
    };

    this.logSignalDebug(symbol, 'BUY_SIGNAL_3', buy3Conditions, {
      currentDayLowTime,
      currentDayHigh,
      currentPrice: d.currentPrice,
      diff: currentDayHigh - d.currentPrice,
    });

    if (Object.values(buy3Conditions).every(Boolean)) {
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
Symbol: <b>${symbol}</b>
Type: <b>${signalType}</b>

Trade Side: <b>${tradeSide}</b>
Entry Price: <b>${entryPrice}</b>

-------------------------
📊 CONDITIONS MET
-------------------------

Gap Type: ${gapType}
Open == FirstCandle: ${openPrice === firstCandleHigh || openPrice === firstCandleLow}

FirstCandleTime: ${firstCandleHighTime}
CurrentHighTime: ${currentDayHighTime}
CurrentLowTime: ${currentDayLowTime}

PrevClose: ${d.prevClose}

NewHigh: ${newHigh}
NewLow: ${newLow}

-------------------------
📈 MARKET DATA
-------------------------

Open: ${openPrice}
High: ${currentDayHigh}
Low: ${currentDayLow}
Price: ${d.currentPrice}

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

  //------------------
  // time check helper
  //------------------
  private isAfterTime(timeStr: string, h: number, m: number) {
    return this.timeToMinutes(timeStr) >= h * 60 + m;
  }

  private isBeforeTime(timeStr: string, h: number, m: number) {
    return this.timeToMinutes(timeStr) <= h * 60 + m;
  }

  // old timeing function
  // private isBefore916(time: string) {
  //   return this.timeToMinutes(time) <= 9 * 60 + 16;
  // }

  // private isAfter930(time: string) {
  //   return this.timeToMinutes(time) >= 9 * 60 + 30;
  // }

  // ------------------
  // Debug Helper
  // ------------------
  private logSignalDebug(
    symbol: string,
    signalName: string,
    conditions: Record<string, boolean>,
    meta?: Record<string, any>,
  ) {
    const failed = Object.entries(conditions)
      .filter(([_, v]) => !v)
      .map(([k]) => k);

    if (failed.length === 0) {
      this.logger.log(`✅ ${symbol} ${signalName} PASSED`);
    } else {
      this.logger.warn(
        `❌ ${symbol} ${signalName} FAILED → ${failed.join(', ')}`,
      );
    }

    // Optional detailed values (only when needed)
    if (failed.length && meta) {
      this.logger.debug(
        `${symbol} ${signalName} DEBUG → ${JSON.stringify(meta)}`,
      );
    }
  }
}
