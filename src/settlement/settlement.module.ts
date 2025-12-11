import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { SettlementController } from './settlement.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [CricketIdModule],
  providers: [SettlementService],
  controllers: [SettlementController],
})
export class SettlementModule {}
