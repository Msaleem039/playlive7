import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [CricketIdModule],
  controllers: [AdminController],
})
export class AdminModule {}
