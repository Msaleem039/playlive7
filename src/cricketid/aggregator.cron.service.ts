import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AggregatorService } from './aggregator.service';

@Injectable()
export class AggregatorCronService {
  private readonly logger = new Logger(AggregatorCronService.name);

  constructor(private readonly aggregatorService: AggregatorService) {}

  @Cron('*/2 * * * * *') // Every 2 seconds (within 2-3 second range)
  async refreshActiveMatchesCache() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      
      if (activeMatches.length === 0) {
        return;
      }

      // Refresh cache for all active matches in parallel
      await Promise.allSettled(
        activeMatches.map((match) =>
          this.aggregatorService.refreshMatchCache(match.eventId, match.marketIds),
        ),
      );

      this.logger.debug(`Refreshed cache for ${activeMatches.length} active matches`);
    } catch (error) {
      this.logger.error('Error in aggregator cron job:', error instanceof Error ? error.message : String(error));
    }
  }
}

