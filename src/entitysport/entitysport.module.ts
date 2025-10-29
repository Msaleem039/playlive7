import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EntitySportController } from './entitysport.controller';
import { EntitySportService } from './entitysport.service';
import { EntitySportGateway } from './entitysport.gateway';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [HttpModule, RedisModule],
  controllers: [EntitySportController],
  providers: [EntitySportService, EntitySportGateway],
  exports: [EntitySportService, EntitySportGateway],
})
export class EntitySportModule {}
