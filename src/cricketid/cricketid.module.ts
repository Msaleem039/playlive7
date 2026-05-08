import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CricketIdController } from './cricketid.controller';
import { CricketIdService } from './cricketid.service';
import { AggregatorService } from './aggregator.service';
import { AggregatorController } from './aggregator.controller';
import { AggregatorCronService } from './aggregator.cron.service';
import { MatchVisibilityService } from './match-visibility.service';
import { RedisModule } from '../common/redis/redis.module';
import { BettingGateway } from '../betting/betting.gateway';

@Module({
  imports: [HttpModule, RedisModule], // ✅ PERFORMANCE: Redis module for vendor data caching
  controllers: [CricketIdController, AggregatorController],
  providers: [
    CricketIdService,
    AggregatorService,
    AggregatorCronService,
    MatchVisibilityService,
    BettingGateway,
  ],
  exports: [CricketIdService, AggregatorService, MatchVisibilityService, BettingGateway],
})
export class CricketIdModule {}

