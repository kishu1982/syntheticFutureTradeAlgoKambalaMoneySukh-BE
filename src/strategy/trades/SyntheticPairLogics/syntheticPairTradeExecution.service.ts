import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MarketService } from 'src/market/market.service';
import { SyntheticPairData } from './syntheticPair.interface';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { isTradingAllowedForExchange } from 'src/common/utils/trading-time.util';

/*
===========================================================
SyntheticPairTradeExecutionService
===========================================================

ROLE
-----
This service is responsible for collecting and maintaining
live market data for synthetic pair monitoring.

It does NOT generate signals and does NOT manage trades.
It only updates market state.

DATA FLOW
---------
Market API (MarketService)
        ↓
Fetch quotes + time series
        ↓
Calculate:
   • currentPrice
   • openPrice
   • currentDayHigh
   • currentDayLow
   • VWAP (from time series)
   • day movement %
        ↓
Update in-memory monitoringData
        ↓
Write to JSON
syntheticPairMonitoringData.json


EXECUTION FLOW
--------------
App Start
   ↓
onModuleInit()
   ↓
Backfill today's candles (09:15 → now)
   ↓
Initialize first candle data
   ↓
Every 1 minute:
   monitorSyntheticPairs()
        ↓
   Update:
      • current price
      • day high/low
      • VWAP
   ↓
   Save updated monitoring JSON


IMPORTANT
---------
This service should NEVER modify:

   • tradeActive
   • entryPrice
   • exitPrice
   • exitReason

Those fields are controlled by:

   • SignalEngineService
   • RMSService


OUTPUT FILE
-----------
data/syntheticPairData/syntheticPairMonitoringData.json


DEPENDENCIES
------------
MarketService
*/

@Injectable()
export class SyntheticPairTradeExecutionService implements OnModuleInit {
  private readonly logger = new Logger(SyntheticPairTradeExecutionService.name);

  private monitoringData: Record<string, SyntheticPairData> = {};

  private executionDone = false;
  private firstCandleInitialized = false;
  private isProcessing = false;
  private readonly TIMESERIES_FOLDER = 'syntheticPairTimeSeries';
  private lastFiveDayAvgCache: Record<string, number> = {};
  private fiveDayAvgReady = false;
  private lastSave = 0;

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  private apiQueue: Promise<any> = Promise.resolve();

  private readonly INDICES = [
    { exchange: 'NFO', token: '51714', symbol: 'NIFTY30MAR26F' },
    // { exchange: 'BSE', token: '1', symbol: 'SENSEX' },
    { exchange: 'NFO', token: '51701', symbol: 'BANKNIFTY30MAR26F' },
  ];

  constructor(
    private readonly marketService: MarketService,
    private readonly configService: ConfigService,
  ) {}

  // ---------------------------------------------------
  // On module init, backfill today's time series data for all indices (if not already backfilled)
  // ---------------------------------------------------
  /*
App Start
   ↓
onModuleInit()
   ↓
backfillTodayTimeSeries()
   ↓
Fetch candles 09:15 → 10:30
   ↓
Overwrite today's files
   ↓
Normal 1-minute sync continues
*/

  async onModuleInit() {
    try {
      this.logger.log('🔄 SyntheticPair startup backfill started');

      await this.backfillTodayTimeSeries();

      // NEW
      // await this.calculateLastFiveDayAverage();
      await this.tryInitializeFiveDayAverage();

      this.logger.log('✅ SyntheticPair startup backfill completed');
    } catch (err) {
      this.logger.error('Startup backfill failed', err?.stack);
    }
  }

  // ------------------------------------------------
  // updating five days data after every 5 min
  // ------------------------------------------------
  // @Interval(1000 * 60 * 2)
  // async updateFiveDayData() {
  //   this.logger.debug('Updating last 5 day average cache every 2 minutes');
  //   await this.calculateLastFiveDayAverage();
  // }
  @Interval(1000 * 60 * 5)
  async retryFiveDayAverage() {
    if (this.fiveDayAvgReady) return;

    this.logger.warn('Retrying 5-day average calculation');

    await this.tryInitializeFiveDayAverage();
  }

  private async tryInitializeFiveDayAverage() {
    await this.calculateLastFiveDayAverage();

    if (Object.keys(this.lastFiveDayAvgCache).length === this.INDICES.length) {
      this.fiveDayAvgReady = true;

      this.logger.log('✅ 5 Day Average Cache Ready');
    } else {
      this.logger.warn(
        '5 Day Average incomplete. Waiting for full EOD candles.',
      );
    }
  }

  // ---------------------------------------------------
  // IST Time helper
  // ---------------------------------------------------

  private getISTTime(): Date {
    return new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
  }

  private getISTDate(): string {
    const now = this.getISTTime();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  private isAfter916(): boolean {
    const now = this.getISTTime();

    const trigger = new Date(now);
    trigger.setHours(9, 16, 0, 0);

    return now >= trigger;
  }

  // ---------------------------------------------------
  // Epoch helper
  // ---------------------------------------------------

  private getEpochTime(hour: number, minute: number): number {
    const now = this.getISTTime();

    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);

    return Math.floor(date.getTime() / 1000);
  }

  // ---------------------------------------------------
  // Fetch previous close
  // ---------------------------------------------------

  // private async getPreviousClose(exchange: string, token: string) {
  //   // const quote = await this.marketService.getQuotes({
  //   //   exch: exchange,
  //   //   token,
  //   // });
  //   const quote = await this.safeGetQuotes(exchange, token);

  //   return Number(quote?.c || 0);
  // }

  // ---------------------------------------------------
  // Fetch first candle
  // ---------------------------------------------------

  private async getFirstCandle(exchange: string, token: string) {
    const start = this.getEpochTime(9, 15);
    const end = this.getEpochTime(9, 16);

    // const series = await this.marketService.getTimePriceSeries({
    //   exchange,
    //   token,
    //   starttime: String(start),
    //   endtime: String(end),
    //   interval: '1',
    // });
    const series = await this.safeGetTimeSeries(
      exchange,
      token,
      String(start),
      String(end),
    );

    if (!series || !series.length) return null;

    const candle = series[0];

    return {
      high: Number(candle.inth),
      low: Number(candle.intl),
      time: candle.time,
    };
  }

  // ---------------------------------------------------
  // Gap calculation
  // ---------------------------------------------------

  private calculateGap(
    prevClose: number,
    high: number,
    low: number,
  ): 'GAP_UP' | 'GAP_DOWN' | 'NO_GAP' {
    if (low > prevClose) return 'GAP_UP';

    if (high < prevClose) return 'GAP_DOWN';

    return 'NO_GAP';
  }

  // ---------------------------------------------------
  // Save JSON file
  // ---------------------------------------------------

  private saveFile() {
    const baseDir = path.join(process.cwd(), 'data');
    const folder = path.join(baseDir, 'syntheticPairData');

    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    const filePath = path.join(folder, 'syntheticPairMonitoringData.json');

    let existing: any = null;

    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    if (existing?.indices) {
      for (const token in this.monitoringData) {
        if (existing.indices[token]) {
          const tradeFields = [
            'tradeActive',
            'tradeSide',
            'entryPrice',
            'entryTime',
            'exitPrice',
            'exitTime',
            'exitReason',
            'maxProfitSeen',
          ];

          for (const field of tradeFields) {
            this.monitoringData[token][field] = existing.indices[token][field];
          }
        }
      }
    }

    const payload = {
      date: this.getISTDate(),
      generatedAt: new Date().toISOString(),
      indices: this.monitoringData,
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    this.logger.log(`Synthetic pair data saved → ${filePath}`);
  }

  // ---------------------------------------------------
  // Main execution
  // ---------------------------------------------------
  // STEP 1 → fetch prev close + first candle
  // STEP 2 → every minute update day high/low
  //
  @Interval(60000)
  async monitorSyntheticPairs() {
    if (!isTradingAllowedForExchange('NFO', this.configService)) {
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Synthetic pair loop already running. Skipping.');
      return;
    }

    this.isProcessing = true;

    try {
      if (!this.isAfter916()) return;

      // clean old files every run (very fast)
      this.cleanOldTimeSeriesFiles();

      if (!this.firstCandleInitialized) {
        await this.initializeFirstCandleData();
        this.firstCandleInitialized = true;
        this.saveFile();
        return;
      }

      await this.updateCurrentDayHighLow();

      this.saveFile();
    } catch (err) {
      this.logger.error('Synthetic pair loop failed', err?.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  //STEP 1 → fetch prev close + first candle

  /*
        NIFTY quote
        ↓ wait 200ms
        SENSEX quote
        ↓ wait 200ms
        BANKNIFTY quote
        ↓ wait 200ms
        loop finished
  */
  private async initializeFirstCandleData() {
    this.logger.log('Initializing synthetic pair data');

    for (const index of this.INDICES) {
      //   const prevClose = await this.getPreviousClose(
      //     index.exchange,
      //     index.token,
      //   );

      await this.sleep(200);

      await this.syncTokenTimeSeries(index.exchange, index.token);

      //  geting series data for updating vwap
      const series = await this.syncTokenTimeSeries(
        index.exchange,
        index.token,
      );
      // getting data of vwap from series and adding to monitoring data
      const vwap = this.extractLatestVWAP(series || []);

      const candle = await this.getFirstCandle(index.exchange, index.token);

      // get quotes also
      const quote = await this.safeGetQuotes(index.exchange, index.token);

      const prevClose = Number(quote?.c || 0);
      const currentPrice = Number(quote?.lp || 0);
      const openPrice = Number(quote?.o || 0);

      await this.sleep(200);

      if (!candle) continue;

      const gapType = this.calculateGap(prevClose, candle.high, candle.low);

      // average movement percentage for the day (to be used in signal engine)
      const avgMove = this.lastFiveDayAvgCache[index.token] || 0;

      const currentMove = this.calculateCurrentDayMove(currentPrice, prevClose);

      // wvap warning
      const warning =
        !vwap || vwap === 0
          ? 'Warning: VWAP datamissing stoploss will not work'
          : '';

      this.monitoringData[index.token] = {
        exchange: index.exchange,
        token: index.token,
        symbol: index.symbol,
        currentPrice,

        prevClose,
        openPrice,

        firstCandleHigh: candle.high,
        firstCandleLow: candle.low,

        firstCandleHighTime: candle.time,
        firstCandleLowTime: candle.time,

        gapType,

        currentDayHigh: candle.high,
        currentDayLow: candle.low,

        currentDayHighTime: candle.time,
        currentDayLowTime: candle.time,

        // NEW average section to be used in signal engine for filtering out low-volatility days
        lastFiveDayAvgMovePct: avgMove,
        currentDayMovePct: currentMove,

        // ✅ NEW for adding wwap data
        vwap,
        vwapWarning: warning,

        // TRADE STATE
        tradeActive: false,
        tradeSide: null,
        entryPrice: 0,
        entryTime: '',

        exitPrice: 0,
        exitTime: '',
        exitReason: '',

        maxProfitSeen: 0,
      };

      this.logger.log(`Initialized ${index.symbol}`);
    }

    this.logger.log('Synthetic pair first candle initialized');
  }

  //   STEP 2 → every minute update day high/low
  private async updateCurrentDayHighLow() {
    for (const index of this.INDICES) {
      const data = this.monitoringData[index.token];
      if (!data) continue;

      // sync last 5 minutes candles
      const series = await this.syncTokenTimeSeries(
        index.exchange,
        index.token,
      );

      // vwap update logic
      const vwap = this.extractLatestVWAP(series || []);

      data.vwap = vwap;

      if (!vwap || vwap === 0) {
        data.vwapWarning = 'Warning: VWAP datamissing stoploss will not work';
      } else {
        data.vwapWarning = '';
      }
      // wvap update logic ends

      if (!series) continue;

      const { high, low, highTime, lowTime } =
        this.calculateDayHighLowFromSeries(series);

      const quote = await this.safeGetQuotes(index.exchange, index.token);

      const currentPrice = Number(quote?.lp || 0);
      const openPrice = Number(quote?.o || 0);

      data.currentPrice = currentPrice;
      data.openPrice = openPrice;

      data.currentDayHigh = high;
      data.currentDayLow = low;

      data.currentDayHighTime = highTime;
      data.currentDayLowTime = lowTime;

      await this.sleep(500);
    }
  }

  // safe guard to avoid rate limit
  private async safeGetQuotes(exchange: string, token: string) {
    return this.queueApiCall(async () => {
      try {
        return await this.marketService.getQuotes({
          exch: exchange,
          token,
        });
      } catch (err) {
        this.logger.warn(
          `Rate limit/API error → retrying | ${exchange}:${token}`,
        );

        await this.sleep(800);

        return await this.marketService.getQuotes({
          exch: exchange,
          token,
        });
      }
    });
  }

  // helper to get file path for time series data
  /*
TPSeries NIFTY
↓
wait 200ms
TPSeries SENSEX
↓
wait 200ms
TPSeries BANKNIFTY
↓
wait 200ms
getQuotes NIFTY
↓
wait 200ms
getQuotes SENSEX
↓
wait 200ms
getQuotes BANKNIFTY
  */
  private getTimeSeriesFilePath(token: string) {
    const baseDir = path.join(process.cwd(), 'data');
    const folder = path.join(baseDir, this.TIMESERIES_FOLDER);

    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder);

    return path.join(folder, `${token}-${this.getISTDate()}.json`);
  }

  // function to sync time series (MAIN ADDITION)
  private async syncTokenTimeSeries(exchange: string, token: string) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 60 * 10; // last 10 minutes

    // const series = await this.marketService.getTimePriceSeries({
    //   exchange,
    //   token,
    //   starttime: String(start),
    //   endtime: String(end),
    //   interval: '1',
    // });
    const series = await this.safeGetTimeSeries(
      exchange,
      token,
      String(start),
      String(end),
    );

    if (!series || !series.length) return;

    const filePath = this.getTimeSeriesFilePath(token);

    let existing: any[] = [];

    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    const map = new Map<string, any>();

    // existing candles
    for (const row of existing) {
      map.set(row.ssboe, row);
    }

    // new candles
    for (const row of series) {
      map.set(row.ssboe, row);
    }

    const merged = Array.from(map.values()).sort(
      (a, b) => Number(a.ssboe) - Number(b.ssboe),
    );

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));

    return merged;
  }

  //function to calculate high/low from stored candles
  private calculateDayHighLowFromSeries(series: any[]) {
    let high = -Infinity;
    let low = Infinity;

    let highTime = '';
    let lowTime = '';

    for (const candle of series) {
      const h = Number(candle.inth);
      const l = Number(candle.intl);

      if (h > high) {
        high = h;
        highTime = candle.time;
      }

      if (l < low) {
        low = l;
        lowTime = candle.time;
      }
    }

    return {
      high,
      low,
      highTime,
      lowTime,
    };
  }

  //wrapper function to queue API calls and avoid hitting rate limits
  private async queueApiCall<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const result = await fn();

      // spacing between API calls
      await this.sleep(200);

      return result;
    };

    this.apiQueue = this.apiQueue.then(run, run);

    return this.apiQueue;
  }

  //Wrap getTimePriceSeries() the same way as getQuotes to ensure we don't hit rate limits when fetching candles
  /*
API fails
   ↓
retry after 800ms
   ↓
if still fails → return null
   ↓
syncTokenTimeSeries skips
   ↓
system continues running
*/

  private async safeGetTimeSeries(
    exchange: string,
    token: string,
    start: string,
    end: string,
  ) {
    return this.queueApiCall(async () => {
      try {
        return await this.marketService.getTimePriceSeries({
          exchange,
          token,
          starttime: start,
          endtime: end,
          interval: '1',
        });
      } catch (err) {
        this.logger.warn(
          `TimeSeries API failed → retrying | ${exchange}:${token}`,
        );

        await this.sleep(800);

        try {
          return await this.marketService.getTimePriceSeries({
            exchange,
            token,
            starttime: start,
            endtime: end,
            interval: '1',
          });
        } catch (err) {
          this.logger.error(
            `TimeSeries retry failed → ${exchange}:${token} with Epoch: ${start}-${end}`,
          );

          return null; // IMPORTANT
        }
      }
    });
  }

  // maintenance function to clean old time series files (keep only today's data) cleanup function

  private cleanOldTimeSeriesFiles() {
    const baseDir = path.join(process.cwd(), 'data');
    const folder = path.join(baseDir, this.TIMESERIES_FOLDER);

    if (!fs.existsSync(folder)) return;

    const today = this.getISTDate();

    const files = fs.readdirSync(folder);

    for (const file of files) {
      // file example: 26000-2026-03-06.json
      if (!file.includes(today)) {
        const fullPath = path.join(folder, file);

        try {
          fs.unlinkSync(fullPath);

          this.logger.log(`🧹 Removed old timeseries file → ${file}`);
        } catch (err) {
          this.logger.warn(`Failed to remove file → ${file}`);
        }
      }
    }
  }

  // ---------------------------------------------------
  // Backfill function to fetch today's candles for all indices on startup (in case service restarts during the day) and save to time series files
  // ---------------------------------------------------
  private async backfillTodayTimeSeries() {
    const now = Math.floor(Date.now() / 1000);

    const start = this.getEpochTime(9, 15);

    // if before market open skip
    if (now < start) {
      this.logger.log('Market not started yet. Skipping backfill.');
      return;
    }

    for (const index of this.INDICES) {
      this.logger.log(`Backfilling ${index.symbol}`);

      const series = await this.safeGetTimeSeries(
        index.exchange,
        index.token,
        String(start),
        String(now),
      );
      await this.sleep(500); // spacing between API calls

      if (!series || !series.length) continue;

      const filePath = this.getTimeSeriesFilePath(index.token);

      const map = new Map<string, any>();

      for (const row of series) {
        map.set(row.ssboe, row);
      }

      const sorted = Array.from(map.values()).sort(
        (a, b) => Number(a.ssboe) - Number(b.ssboe),
      );

      fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2));

      this.logger.log(
        `Backfilled ${sorted.length} candles for ${index.symbol}`,
      );
    }
  }

  // ---------------------------------------------------
  // Calculate last 5 days' average movement percentage and cache it (to be used in signal engine)
  // ---------------------------------------------------
  private async calculateLastFiveDayAverage() {
    this.logger.log('Calculating last 5 day average movement');

    const now = Math.floor(Date.now() / 1000);
    const sixDaysAgo = now - 86400 * 12; // 12 days ago to be safe (to account for non-trading days)

    for (const index of this.INDICES) {
      try {
        const data = await this.marketService.getEodChartData({
          exchange: index.exchange,
          tradingsymbol: index.symbol,
          from: sixDaysAgo,
          to: now,
        });
        // this.logger.debug(`EOD data for ${index.symbol}: `, data);

        // if (!data?.candles || data.candles.length < 6) continue;
        if (!data?.candles || data.candles.length < 6) {
          this.logger.warn(
            `${index.symbol} insufficient EOD candles (${data?.candles?.length || 0})`,
          );
          continue;
        }

        const candles = data.candles
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(-6); // get last 6 candles

        const movements: number[] = [];

        for (let i = 1; i < candles.length; i++) {
          //for (let i = 1; i < 6; i++) {
          const prevClose = candles[i - 1].close;
          const close = candles[i].close;

          const pct = Math.abs(((close - prevClose) / prevClose) * 100);

          movements.push(pct);
        }

        const avg = movements.reduce((sum, v) => sum + v, 0) / movements.length;

        this.lastFiveDayAvgCache[index.token] = Number(avg.toFixed(2));

        this.logger.log(`${index.symbol} 5D Avg Move = ${avg.toFixed(2)}%`);
      } catch (err) {
        this.logger.error(`Failed avg calc ${index.symbol}`);
      }

      await this.sleep(200);
    }
  }

  // helper to get current day movement percentage (to be used in signal engine)
  private calculateCurrentDayMove(currentPrice: number, prevClose: number) {
    if (!prevClose) return 0;

    const pct = ((currentPrice - prevClose) / prevClose) * 100;

    return Number(Math.abs(pct).toFixed(2));
  }

  // ---------------------------------------------------
  // Extract latest VWAP from timeseries
  // ---------------------------------------------------

  private extractLatestVWAP(series: any[]) {
    if (!series || !series.length) return 0;

    const last = series[series.length - 1];

    const vwap = Number(last?.intvwap || 0);

    return vwap;
  }

  // ---------------------------------------------------
  // Realtime Tick Handler (Websocket)
  // ---------------------------------------------------

  // public handleRealtimeTick(tick: any) {
  //   try {
  //     // this.logger.debug(
  //     //   `getting tick data test high for ${tick.tk}`,
  //     //   tick.h ? tick.h : '',
  //     // );
  //     // this.logger.debug(
  //     //   `getting tick data test Low for ${tick.tk}`,
  //     //   tick?.l ? tick.l : '',
  //     // );

  //     // tick?.h
  //     //   ? this.logger.debug(`High of token : ${tick.tk} is : ${tick.h}`)
  //     //   : '';
  //     // tick?.l
  //     //   ? this.logger.debug(`low of token : ${tick.tk} is : ${tick.l}`)
  //     //   : '';

  //     if (!this.isAfter916()) return;

  //     const token = String(tick.tk);

  //     const data = this.monitoringData[token];

  //     if (!data) return; // token not monitored

  //     // const price = Number(tick?.lp || 0);

  //     // if (!price) return;

  //     const price = Number(tick?.lp);
  //     if (!price || !tick?.tk) return;

  //     // setting up high and low value
  //     const wsHigh = Number(tick?.h ? tick.h : price);
  //     const wsLow = Number(tick?.l ? tick.l : price);

  //     const now = this.getISTTime();

  //     const timeString = now
  //       .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
  //       .replace(',', '');

  //     // update current price
  //     data.currentPrice = price;

  //     //temporarliy stoping as updating based on new data.
  //     // update high
  //     if (wsHigh > data.currentDayHigh) {
  //       data.currentDayHigh = wsHigh;
  //       data.currentDayHighTime = timeString;
  //     }

  //     // update low
  //     if (wsLow < data.currentDayLow) {
  //       data.currentDayLow = wsLow;
  //       data.currentDayLowTime = timeString;
  //     }

  //     // update day move %
  //     data.currentDayMovePct = this.calculateCurrentDayMove(
  //       price,
  //       data.prevClose,
  //     );

  //     // save file realtime
  //     this.saveFile();
  //   } catch (err) {
  //     this.logger.error('Realtime tick update failed', err?.stack);
  //   }
  // }
  public handleRealtimeTick(tick: any) {
    //return; // temp return
    try {
      // timer check
      if (!isTradingAllowedForExchange('NFO', this.configService)) {
        return;
      }

      // log debug area

      //     // this.logger.debug(
      //     //   `getting tick data test high for ${tick.tk}`,
      //     //   tick.h ? tick.h : '',
      //     // );
      //     // this.logger.debug(
      //     //   `getting tick data test Low for ${tick.tk}`,
      //     //   tick?.l ? tick.l : '',
      //     // );

      //     // tick?.h
      //     //   ? this.logger.debug(`High of token : ${tick.tk} is : ${tick.h}`)
      //     //   : '';
      //     // tick?.l
      //     //   ? this.logger.debug(`low of token : ${tick.tk} is : ${tick.l}`)
      //     //   : '';

      // log debug area ends

      if (!this.isAfter916()) return;

      if (!tick?.tk) return;

      const token = String(tick.tk);

      // IMPORTANT: only process tokens we monitor
      const data = this.monitoringData[token];
      if (!data) return;

      const price = Number(tick?.lp);
      if (!price || price <= 0) return;

      const now = this.getISTTime();

      const timeString = now
        .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
        .replace(',', '');

      // -------------------------------
      // Determine High / Low safely
      // -------------------------------

      const wsHigh = Math.max(price, Number(tick?.h ?? price));

      const wsLow = Math.min(price, Number(tick?.l ?? price));

      // -------------------------------
      // Update current price
      // -------------------------------

      if (data.currentPrice !== price) {
        data.currentPrice = price;
      }

      // -------------------------------
      // Update Day High
      // -------------------------------

      if (wsHigh > data.currentDayHigh && data.currentDayHigh > 0) {
        data.currentDayHigh = wsHigh;
        data.currentDayHighTime = timeString;
      }

      // -------------------------------
      // Update Day Low
      // -------------------------------

      if (wsLow < data.currentDayLow && data.currentDayLow > 0) {
        data.currentDayLow = wsLow;
        data.currentDayLowTime = timeString;
      }

      // -------------------------------
      // Update Day Move %
      // -------------------------------

      data.currentDayMovePct = this.calculateCurrentDayMove(
        price,
        data.prevClose,
      );

      // -------------------------------
      // Throttle JSON file saves
      // -------------------------------

      const nowTs = Date.now();

      if (nowTs - this.lastSave > 2000) {
        this.saveFile();
        this.lastSave = nowTs;
      }
    } catch (err) {
      this.logger.error('Realtime tick update failed', err?.stack);
    }
  }
}
