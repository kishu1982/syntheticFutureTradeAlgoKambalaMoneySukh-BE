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
}
