import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CricketIdController } from './cricketid.controller';
import { CricketIdService } from './cricketid.service';
import { CricketIdWebhookService } from './cricketid.webhook';
import { OddsGateway } from './odds.gateway';
import { AggregatorService } from './aggregator.service';
import { AggregatorController } from './aggregator.controller';

@Module({
  imports: [HttpModule],
  controllers: [CricketIdController, AggregatorController],
  providers: [CricketIdService, CricketIdWebhookService, OddsGateway, AggregatorService],
  exports: [CricketIdService, AggregatorService],
})
export class CricketIdModule {}

