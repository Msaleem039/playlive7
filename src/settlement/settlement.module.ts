import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { PnlService } from './pnl.service';
import { HierarchyPnlService } from './hierarchy-pnl.service';
import { SettlementController } from './settlement.controller';
import { SettlementAdminController } from './settlement-admin.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { RedisModule } from '../common/redis/redis.module';
import { BackgroundProcessorModule } from '../common/background/background-processor.module';
import { FancyExposureService } from '../bets/fancy-exposure.service';
import { MatchOddsExposureService } from '../bets/matchodds-exposure.service';
import { BookmakerExposureService } from '../bets/bookmaker-exposure.service';

@Module({
  imports: [
    CricketIdModule,
    RedisModule, // ✅ PERFORMANCE: Redis for snapshot invalidation
    BackgroundProcessorModule, // ✅ PERFORMANCE: Background processing for PnL recalculation
  ],
  providers: [
    SettlementService,
    PnlService,
    HierarchyPnlService,
    FancyExposureService,
    MatchOddsExposureService,
    BookmakerExposureService,
  ],
  controllers: [SettlementController, SettlementAdminController],
  exports: [PnlService, HierarchyPnlService],
})
export class SettlementModule {}
