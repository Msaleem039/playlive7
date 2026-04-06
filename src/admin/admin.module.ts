import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { BetsModule } from '../bets/bets.module';

@Module({
  imports: [CricketIdModule, BetsModule],
  controllers: [AdminController],
})
export class AdminModule {}
