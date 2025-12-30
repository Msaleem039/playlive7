import { Module } from '@nestjs/common';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { PositionModule } from '../positions/position.module';

@Module({
  imports: [CricketIdModule, PositionModule],
  controllers: [BetsController],
  providers: [BetsService],
})
export class BetsModule {}


