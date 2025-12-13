import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CricketIdService } from './cricketid.service';
import { OddsGateway } from './odds.gateway';

@Injectable()
export class OddsCronService {
  private readonly logger = new Logger(OddsCronService.name);

  constructor(
    private readonly cricketService: CricketIdService,
    private readonly oddsGateway: OddsGateway,
  ) {}

  @Cron('*/4 * * * * *') // Every 4 seconds (between 3-5 seconds)
  async fetchAndEmitOdds() {
    try {
      await this.oddsGateway.fetchAndEmitOddsForAllRooms();
    } catch (error) {
      this.logger.error('Error in odds cron job:', error instanceof Error ? error.message : String(error));
    }
  }
}

