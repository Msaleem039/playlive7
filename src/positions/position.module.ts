import { Module } from '@nestjs/common';
import { PositionService } from './position.service';
import { PositionsController } from './positions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [PrismaModule, CricketIdModule],
  controllers: [PositionsController],
  providers: [PositionService],
  exports: [PositionService],
})
export class PositionModule {}








