import { Module } from '@nestjs/common';
import { PositionService } from './position.service';
import { PositionsController } from './positions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CricketIdModule } from '../cricketid/cricketid.module';
import { RedisModule } from '../common/redis/redis.module';

@Module({
  imports: [PrismaModule, CricketIdModule, RedisModule], // ✅ PERFORMANCE: Redis for position snapshots
  controllers: [PositionsController],
  providers: [PositionService],
  exports: [PositionService],
})
export class PositionModule {}








