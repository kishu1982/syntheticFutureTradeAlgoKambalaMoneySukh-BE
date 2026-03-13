/*
===========================================================
SYNTHETIC FUTURES ALGO ARCHITECTURE
===========================================================

Market Data Engine
(SyntheticPairTradeExecutionService)
        ↓
Updates market state JSON
        ↓
Signal Engine
(SyntheticPairSignalEngineService)
        ↓
Generates entry signals
        ↓
RMS Engine
(SyntheticPairRmsService)
        ↓
Manages stoploss and exits
        ↓
Telegram Alerts


DATA STORAGE
------------
data/syntheticPairData/syntheticPairMonitoringData.json


EXECUTION FREQUENCY
-------------------

TradeExecutionService → every 60 sec
SignalEngineService   → every 60 sec
RMSService            → every 2 sec
*/

export interface SyntheticPairData {
  exchange: string;
  token: string;
  symbol: string;
  currentPrice: number;

  prevClose: number;
  openPrice: number; // ADD THIS

  firstCandleHigh: number;
  firstCandleLow: number;

  firstCandleHighTime: string;
  firstCandleLowTime: string;

  gapType: 'GAP_UP' | 'GAP_DOWN' | 'NO_GAP';

  currentDayHigh: number;
  currentDayLow: number;

  currentDayHighTime: string;
  currentDayLowTime: string;

  // NEW
  lastFiveDayAvgMovePct: number;
  currentDayMovePct: number;

  // ✅ NEW
  vwap?: number;
  vwapWarning?: string;

  // -------------------
  // TRADE STATE
  // -------------------

  tradeActive?: boolean;
  tradeSide?: 'BUY' | 'SELL' | null;
  entryPrice?: number;
  entryTime?: string;

  exitPrice?: number;
  exitTime?: string;
  exitReason?: string;

  maxProfitSeen?: number;
}
