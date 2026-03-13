/*
===========================================================
SyntheticPairRmsService
===========================================================

ROLE
-----
This service acts as the Risk Management System (RMS)
for the Synthetic Futures trading strategy.

Its responsibility is to continuously monitor active trades
and enforce exit rules based on market conditions.

The RMS never creates trades.
It only manages exits and risk control.


===========================================================
HIGH LEVEL FLOW
===========================================================

Market Tick Data
        ↓
SyntheticPairSignalEngine
        ↓
Trade gets activated
        ↓
tradeActive = true
entryPrice stored in JSON
        ↓
SyntheticPairRmsService starts monitoring
        ↓
Every second RMS checks exit conditions
        ↓
If any exit condition triggers:
   • tradeActive → false
   • exitPrice updated
   • exitTime updated
   • exitReason stored
        ↓
JSON file updated
        ↓
Telegram exit alert sent


===========================================================
DATA SOURCE
===========================================================

RMS reads trading data from:

data/syntheticPairData/syntheticPairMonitoringData.json

This file contains live market information and trade state
for each index token.

Structure:

indices
   ├── token
   │     ├── symbol
   │     ├── currentPrice
   │     ├── prevClose
   │     ├── currentDayHigh
   │     ├── currentDayLow
   │     ├── vwap
   │     ├── tradeActive
   │     ├── tradeSide
   │     ├── entryPrice
   │     └── maxProfitSeen


===========================================================
EXECUTION LOOP
===========================================================

The RMS runs every 1 second.

@Interval(1000)

Execution flow:

1️⃣ Check if trading allowed for exchange

   Uses utility:
   isTradingAllowedForExchange()

2️⃣ Load monitoring JSON file

3️⃣ Loop through all index tokens

4️⃣ For each token:

   If tradeActive == false
      → Skip

   If tradeActive == true
      → Evaluate exit conditions

5️⃣ If exit condition triggered

   exitTrade()

6️⃣ Update JSON file


===========================================================
EXIT CONDITION PRIORITY
===========================================================

Exit checks run in this order:

1️⃣ Day Reversal + Range Stoploss
2️⃣ VWAP Exit
3️⃣ Profit Trailing Exit

First condition that triggers
immediately exits the trade.


===========================================================
EXIT CONDITION 1
DAY REVERSAL + RANGE STOPLOSS
===========================================================

Two stoploss calculations are performed
and the stronger one is used.

STOPLOSS TYPE 1
Day Reversal Stop

SELL
stop = dayLow + X%

BUY
stop = dayHigh - X%


STOPLOSS TYPE 2
Range Based Stop

Range calculated from previous close.

SELL

range = prevClose - dayLow

rangeStopMove =
   max(
       range * 0.25,
       prevClose * RangeStopPct
   )

stop = dayLow + rangeStopMove


BUY

range = dayHigh - prevClose

rangeStopMove =
   max(
       range * 0.25,
       prevClose * RangeStopPct
   )

stop = dayHigh - rangeStopMove


FINAL STOP

SELL
finalStop = max(dayReversalStop , rangeStop)

BUY
finalStop = min(dayReversalStop , rangeStop)


Exit triggered when:

SELL
currentPrice > finalStop

BUY
currentPrice < finalStop


Exit Reason:
DAY_REVERSAL_RANGE_SL


===========================================================
EXIT CONDITION 2
VWAP EXIT
===========================================================

SELL

Exit if:
currentPrice > vwap + X%

BUY

Exit if:
currentPrice < vwap - X%


Exit Reason:
VWAP_EXIT


===========================================================
EXIT CONDITION 3
PROFIT TRAILING
===========================================================

Tracks maximum profit achieved during trade.

Profit calculation:

SELL
profit = entryPrice - currentPrice

BUY
profit = currentPrice - entryPrice


Trailing logic:

1️⃣ Wait until profit exceeds
   ProfitTrailStartPct

2️⃣ Once triggered
   track maxProfitSeen

3️⃣ Exit when profit retraces

   retrace = maxProfitSeen * retracePct


Exit Reason:
PROFIT_TRAIL_EXIT


===========================================================
EXIT EXECUTION
===========================================================

When an exit condition triggers:

1️⃣ tradeActive = false

2️⃣ exitPrice = currentPrice

3️⃣ exitTime = IST timestamp

4️⃣ exitReason stored

5️⃣ JSON file updated

6️⃣ Telegram alert sent


===========================================================
TELEGRAM ALERT FORMAT
===========================================================

🚨 SYNTHETIC EXIT

Symbol
Side
Entry Price
Exit Price
Exit Reason
Timestamp


===========================================================
ENV VARIABLES
===========================================================

SyntheticFutAlgo_StopLossDayReversalPct
SyntheticFutAlgo_RangeStopLossPct
SyntheticFutAlgo_VwapExitPct
SyntheticFutAlgo_ProfitTrailStartPct
SyntheticFutAlgo_ProfitTrailRetracePct


===========================================================
IMPORTANT DESIGN RULE
===========================================================

RMS must ONLY control:

• tradeActive
• exitPrice
• exitTime
• exitReason
• maxProfitSeen

RMS must NEVER modify:

• entryPrice
• tradeSide
• market data fields


===========================================================
OUTPUT
===========================================================

The RMS updates exit related fields in:

syntheticPairMonitoringData.json
*/

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramService } from 'src/telegram/telegram.service';
import { isTradingAllowedForExchange } from './../../../common/utils/trading-time.util';

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
    const dayReversalPct =
      Number(
        this.config.get('SyntheticFutAlgo_StopLossDayReversalPct') ?? 0.25,
      ) / 100;

    const rangePct =
      Number(this.config.get('SyntheticFutAlgo_RangeStopLossPct') ?? 0.25) /
      100;

    // -----------------------
    // SELL SIDE
    // -----------------------

    if (d.tradeSide === 'SELL') {
      const dayReversalStop = d.currentDayLow * (1 + dayReversalPct);

      const range = d.prevClose - d.currentDayLow;

      const rangeStopMove = Math.max(range * 0.25, d.prevClose * rangePct);

      const rangeStop = d.currentDayLow + rangeStopMove;

      const finalStop = Math.max(dayReversalStop, rangeStop);

      if (d.currentPrice > finalStop) {
        return 'DAY_REVERSAL_RANGE_SL';
      }
    }

    // -----------------------
    // BUY SIDE
    // -----------------------

    if (d.tradeSide === 'BUY') {
      const dayReversalStop = d.currentDayHigh * (1 - dayReversalPct);

      const range = d.currentDayHigh - d.prevClose;

      const rangeStopMove = Math.max(range * 0.25, d.prevClose * rangePct);

      const rangeStop = d.currentDayHigh - rangeStopMove;

      const finalStop = Math.min(dayReversalStop, rangeStop);

      if (d.currentPrice < finalStop) {
        return 'DAY_REVERSAL_RANGE_SL';
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
