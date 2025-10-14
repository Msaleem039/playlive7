import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EntitySportController } from './entitysport.controller';
import { EntitySportService } from './entitysport.service';

@Module({
  imports: [HttpModule],
  controllers: [EntitySportController],
  providers: [EntitySportService],
  exports: [EntitySportService],
})
export class EntitySportModule {}
