import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramService } from 'src/telegram/telegram.service';
import { isTradingAllowedForExchange } from './../../../common/utils/trading-time.util';

/*
===========================================================
SyntheticPairRmsService
===========================================================

ROLE
-----
This service manages trade risk and exits.

It continuously monitors active trades and
applies exit logic based on defined rules.

DATA FLOW
---------
syntheticPairMonitoringData.json
        ↓
RMS reads JSON every 2 seconds
        ↓
Check tradeActive
        ↓
Evaluate exit rules
        ↓
If exit triggered:
   • mark tradeActive = false
   • set exitPrice
   • set exitTime
   • set exitReason
        ↓
Update JSON
        ↓
Send Telegram exit alert


EXIT CONDITIONS
---------------

1️⃣ Day Reversal Stoploss

SELL
  exit if price > dayLow + X%

BUY
  exit if price < dayHigh - X%


2️⃣ VWAP Exit

SELL
  exit if price > vwap + X%
 
BUY
  exit if price < vwap - X%


3️⃣ Profit Trailing

If profit exceeds threshold:

start trailing stop.

Exit when profit retraces
configured percentage.


ENV VARIABLES
-------------
SyntheticFutAlgo_StopLossDayReversalPct
SyntheticFutAlgo_VwapExitPct
SyntheticFutAlgo_ProfitTrailStartPct
SyntheticFutAlgo_ProfitTrailRetracePct


TELEGRAM ALERT
--------------
🚨 SYNTHETIC EXIT

Symbol
Side
Entry price
Exit price
Exit reason
Timestamp


EXECUTION LOOP
--------------
Runs every 2 seconds.


IMPORTANT
---------
RMS should ONLY control:

• tradeActive
• exitPrice
• exitTime
• exitReason
• maxProfitSeen


INPUT FILE
----------
syntheticPairMonitoringData.json


OUTPUT
------
Updates trade exit fields in JSON.
*/
@Injectable()
export class SyntheticPairRmsService {
  private readonly logger = new Logger(SyntheticPairRmsService.name);

  private readonly FILE_PATH = path.join(
    process.cwd(),
    'data',
    'syntheticPairData',
    'syntheticPairMonitoringData.json',
  );

  constructor(
    private readonly config: ConfigService,
    private telegramService: TelegramService,
  ) {}

  // ------------------------------------------------
  // MAIN RMS LOOP
  // ------------------------------------------------

  @Interval(1000)
  async monitorTrades() {
    if (!isTradingAllowedForExchange('NFO', this.config)) {
      return;
    }

    if (!fs.existsSync(this.FILE_PATH)) return;

    const raw = fs.readFileSync(this.FILE_PATH, 'utf8');
    const json = JSON.parse(raw);

    let updated = false;

    for (const token in json.indices) {
      const d = json.indices[token];

      // this.logger.debug(`exchange found is : `, d.exchange);

      if (!d.tradeActive) continue;

      const exitReason = this.evaluateExit(d);

      if (exitReason) {
        await this.exitTrade(d, exitReason);
        updated = true;
      }
    }

    if (updated) {
      fs.writeFileSync(this.FILE_PATH, JSON.stringify(json, null, 2));
    }
  }

  // ------------------------------------------------
  // CONDITION 1
  // Day Reversal Stoploss
  // ------------------------------------------------

  private dayReversalExit(d: any): string | null {
    const pct =
      Number(
        this.config.get('SyntheticFutAlgo_StopLossDayReversalPct') ?? 0.25,
      ) / 100;

    if (d.tradeSide === 'SELL') {
      const stop = d.currentDayLow * (1 + pct);

      if (d.currentPrice > stop) {
        return 'DAY_LOW_REVERSAL';
      }
    }

    if (d.tradeSide === 'BUY') {
      const stop = d.currentDayHigh * (1 - pct);

      if (d.currentPrice < stop) {
        return 'DAY_HIGH_REVERSAL';
      }
    }

    return null;
  }

  // ------------------------------------------------
  // CONDITION 2
  // VWAP EXIT
  // ------------------------------------------------

  private vwapExit(d: any): string | null {
    if (!d.vwap || d.vwap === 0) return null;

    const pct =
      Number(this.config.get('SyntheticFutAlgo_VwapExitPct') ?? 0.1) / 100;

    if (d.tradeSide === 'SELL') {
      if (d.currentPrice > d.vwap * (1 + pct)) {
        return 'VWAP_EXIT';
      }
    }

    if (d.tradeSide === 'BUY') {
      if (d.currentPrice < d.vwap * (1 - pct)) {
        return 'VWAP_EXIT';
      }
    }

    return null;
  }

  // ------------------------------------------------
  // CONDITION 3
  // PROFIT TRAILING
  // ------------------------------------------------

  private profitTrailExit(d: any): string | null {
    const startPct =
      Number(this.config.get('SyntheticFutAlgo_ProfitTrailStartPct') ?? 0.5) /
      100;

    const retracePct =
      Number(this.config.get('SyntheticFutAlgo_ProfitTrailRetracePct') ?? 50) /
      100;

    const entry = d.entryPrice;

    if (!entry) return null;

    let profit = 0;

    if (d.tradeSide === 'SELL') {
      profit = entry - d.currentPrice;
    } else if (d.tradeSide === 'BUY') {
      profit = d.currentPrice - entry;
    }

    if (profit > d.maxProfitSeen) {
      d.maxProfitSeen = profit;
    }

    const trigger = entry * startPct;

    if (d.maxProfitSeen < trigger) return null;

    const retrace = d.maxProfitSeen * retracePct;

    if (profit < d.maxProfitSeen - retrace) {
      return 'PROFIT_TRAIL_EXIT';
    }

    return null;
  }

  // ------------------------------------------------
  // EXIT HANDLER for updating json file and sending telegram message
  // ------------------------------------------------

  private async exitTrade(d: any, reason: string) {
    d.tradeActive = false;
    d.exitPrice = d.currentPrice;

    const now = this.getISTTime();
    const date = now.toLocaleDateString('en-GB');
    const time = now.toLocaleTimeString('en-GB');

    d.exitTime = `${date} ${time}`;

    d.exitReason = reason;

    this.logger.warn(`EXIT ${d.symbol} | ${reason}`);

    const message = `
🚨 <b>SYNTHETIC EXIT</b>

Symbol: ${d.symbol}

Side: ${d.tradeSide}

Entry: ${d.entryPrice}
Exit: ${d.exitPrice}

Reason: ${reason}

Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
`;

    await this.telegramService.sendMessage(message);
  }

  // ------------------------------------------------
  // CHECK ALL EXIT CONDITIONS
  // ------------------------------------------------

  private evaluateExit(d: any): string | null {
    const dayReversal = this.dayReversalExit(d);
    if (dayReversal) return dayReversal;

    const vwapExit = this.vwapExit(d);
    if (vwapExit) return vwapExit;

    const trailExit = this.profitTrailExit(d);
    if (trailExit) return trailExit;

    return null;
  }

  //-----------
  // helper to convert time to india time
  //
  private getISTTime(): Date {
    return new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
  }
}
