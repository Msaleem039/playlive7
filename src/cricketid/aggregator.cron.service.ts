import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AggregatorService } from './aggregator.service';
import { CricketIdService } from './cricketid.service';

@Injectable()
export class AggregatorCronService {
  private readonly logger = new Logger(AggregatorCronService.name);

  constructor(
    private readonly aggregatorService: AggregatorService,
    private readonly cricketIdService: CricketIdService,
  ) {}

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

  @Cron('*/3 * * * * *') // Every 3 seconds
  async fetchBookmakerFancyAndOdds() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      
      if (activeMatches.length === 0) {
        return;
      }

      // Fetch bookmaker fancy and odds for all active matches in parallel
      const fetchPromises = activeMatches.flatMap((match) => [
        this.cricketIdService.getBookmakerFancy(match.eventId).then(
          (result) => ({
            type: 'fancy' as const,
            eventId: match.eventId,
            success: true,
            data: result,
          }),
          (error) => ({
            type: 'fancy' as const,
            eventId: match.eventId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        this.cricketIdService.getBetfairOdds(match.marketIds).then(
          (result) => ({
            type: 'odds' as const,
            marketIds: match.marketIds,
            success: true,
            data: result,
          }),
          (error) => ({
            type: 'odds' as const,
            marketIds: match.marketIds,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ]);

      const results = await Promise.all(fetchPromises);

      // Log results
      results.forEach((result) => {
        if (result.success) {
          if (result.type === 'fancy') {
            this.logger.debug(`Successfully fetched bookmaker fancy for eventId ${result.eventId}`);
          } else if (result.type === 'odds') {
            this.logger.debug(`Successfully fetched odds for marketIds ${result.marketIds}`);
          }
        } else {
          const errorMsg = 'error' in result ? result.error : 'Unknown error';
          if (result.type === 'fancy') {
            this.logger.warn(`Failed to fetch bookmaker fancy for eventId ${result.eventId}: ${errorMsg}`);
          } else if (result.type === 'odds') {
            this.logger.warn(`Failed to fetch odds for marketIds ${result.marketIds}: ${errorMsg}`);
          }
        }
      });

      this.logger.debug(`Fetched bookmaker fancy and odds for ${activeMatches.length} active matches`);
    } catch (error) {
      this.logger.error(
        'Error in bookmaker fancy and odds cron job:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

