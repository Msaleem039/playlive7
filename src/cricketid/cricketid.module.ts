import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CricketIdController } from './cricketid.controller';
import { CricketIdService } from './cricketid.service';
import { CricketIdWebhookService } from './cricketid.webhook';
import { OddsGateway } from './odds.gateway';

@Module({
  imports: [HttpModule],
  controllers: [CricketIdController],
  providers: [CricketIdService, CricketIdWebhookService, OddsGateway],
  exports: [CricketIdService],
})
export class CricketIdModule {}

