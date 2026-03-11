import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramService } from 'src/telegram/telegram.service';

@Injectable()
export class SyntheticPairSignalEngineService {
  /*
Every 1 minute:

Check if JSON exists

Check if date == today

Read index data

Evaluate signals

Prevent duplicate signals

Send Telegram alerts

Log signals

///////////////////////////////////////////////

SyntheticPairData Engine
        ↓
writes JSON every minute
        ↓
Signal Engine
        ↓
reads JSON every minute
        ↓
evaluates signals
        ↓
logs + telegram alert
        ↓
execution engine
*/

  private readonly logger = new Logger(SyntheticPairSignalEngineService.name);
  private lastObservedLevels = new Map<string, { high: number; low: number }>();
  private dayRangeBlockNotified = new Map<string, string>();

  private readonly FILE_PATH = path.join(
    process.cwd(),
    'data',
    'syntheticPairData',
    'syntheticPairMonitoringData.json',
  );

  private signalState = new Map<string, boolean>();

  constructor(private readonly telegramService: TelegramService) {}

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

  @Interval(60000)
  async checkSignals() {
    try {
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

    if (d.currentDayHigh > last.high) newHigh = true;
    if (d.currentDayLow < last.low) newLow = true;

    this.lastObservedLevels.set(token, {
      high: d.currentDayHigh,
      low: d.currentDayLow,
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
    // DAY RANGE FILTER
    // ------------------------------------------------

    if (currentDayMovePct > lastFiveDayAvgMovePct) {
      const today = this.getISTDate();
      const notifyKey = `${token}_${today}`;

      this.logger.warn(
        `${symbol} signal blocked → DayMove ${currentDayMovePct}% > Avg5Day ${lastFiveDayAvgMovePct}%`,
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
5 Day Avg Move: <b>${lastFiveDayAvgMovePct}%</b>

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

    const stateKey = `${token}`;

    if (!this.signalState.has(stateKey)) {
      this.signalState.set(stateKey, false);
    }

    if (this.signalState.get(stateKey)) return;

    let signal: string | null = null;
    let signalType: string | null = null;

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

    this.signalState.set(stateKey, true);

    this.logger.log(`${symbol} ${signal}`);

    const message = `
📢 <b>SYNTHETIC SIGNAL</b>

Signal: ${signal}
Type: ${signalType}

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
}
