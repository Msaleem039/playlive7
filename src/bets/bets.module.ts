import { Module } from '@nestjs/common';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [CricketIdModule],
  controllers: [BetsController],
  providers: [BetsService],
})
export class BetsModule {}


