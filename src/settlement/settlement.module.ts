import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { PnlService } from './pnl.service';
import { SettlementController } from './settlement.controller';
import { SettlementAdminController } from './settlement-admin.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [CricketIdModule],
  providers: [SettlementService, PnlService],
  controllers: [SettlementController, SettlementAdminController],
  exports: [PnlService],
})
export class SettlementModule {}
