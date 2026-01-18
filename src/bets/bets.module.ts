import { Module } from '@nestjs/common';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { MatchOddsExposureService } from './matchodds-exposure.service';
import { BookmakerExposureService } from './bookmaker-exposure.service';
import { FancyExposureService } from './fancy-exposure.service';

@Module({
  imports: [CricketIdModule],
  controllers: [BetsController],
  providers: [
    BetsService,
    MatchOddsExposureService,
    BookmakerExposureService,
    FancyExposureService,
  ],
})
export class BetsModule {}


