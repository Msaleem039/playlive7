import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { BetsModule } from '../bets/bets.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CricketIdModule, BetsModule, AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}
