import { Module } from '@nestjs/common';
import { BetsController } from './bets.controller';
import { BetsService } from './bets.service';

@Module({
  controllers: [BetsController],
  providers: [BetsService],
})
export class BetsModule {}


