import { Module } from '@nestjs/common';
import { TradesService } from './trades.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinalTradeToBePlacedEntity } from './entities/final-trade-to-be-placed.entity';
import { TradesController } from './trades.controller';
import { TradesExecutionService } from './trades-execution.service';
import { MarketModule } from 'src/market/market.module';
import { OrdersModule } from 'src/orders/orders.module';
import { ScheduleModule } from '@nestjs/schedule';
import { StoplossTargetService } from './stoploss-target/stoploss-target.service';
import { SyntheticPairTradeExecutionService } from './SyntheticPairLogics/syntheticPairTradeExecution.service';
import { SyntheticPairSignalEngineService } from './SyntheticPairLogics/syntheticPairSignalEngine.service';
import { TelegramModule } from 'src/telegram/telegram.module';
import { SyntheticPairRmsService } from './SyntheticPairLogics/syntheticPairRms.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FinalTradeToBePlacedEntity]),
    MarketModule, // ✅ ADD THIS
    OrdersModule, // ✅ ADD THIS
    ScheduleModule.forRoot(),
    TelegramModule, // TO RUN SCHEDULED JOBS FOR TRADES EXECUTION
  ],
  providers: [
    TradesService,
    TradesExecutionService,
    StoplossTargetService,
    SyntheticPairTradeExecutionService,
    SyntheticPairSignalEngineService,
    SyntheticPairRmsService,
  ], // ✅ ADD THIS
  exports: [
    TradesService,
    TradesExecutionService,
    StoplossTargetService, // optional (only if used outside)
    SyntheticPairTradeExecutionService,
    SyntheticPairRmsService,
  ],
  controllers: [TradesController],
})
export class TradesModule {}
