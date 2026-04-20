import { Module } from '@nestjs/common';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { MatchOddsExposureService } from './matchodds-exposure.service';
import { BookmakerExposureService } from './bookmaker-exposure.service';
import { FancyExposureService } from './fancy-exposure.service';
import { BetProcessingQueue } from './bet-processing.queue';
import { BetProcessingWorker } from './bet-processing.worker';
import { Playlive24OriginGuard } from '../common/guards/playlive24-origin.guard';

@Module({
  imports: [CricketIdModule],
  controllers: [BetsController],
  providers: [
    Playlive24OriginGuard,
    BetsService,
    MatchOddsExposureService,
    BookmakerExposureService,
    FancyExposureService,
    BetProcessingQueue,
    BetProcessingWorker,
  ],
  exports: [BetsService],
})
export class BetsModule {}


