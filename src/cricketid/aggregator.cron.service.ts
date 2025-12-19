import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AggregatorService } from './aggregator.service';

@Injectable()
export class AggregatorCronService {
  private readonly logger = new Logger(AggregatorCronService.name);
  // Internal server base URL - can be moved to environment variable
  private readonly internalBaseUrl = process.env.INTERNAL_API_URL || 'https://72.61.140.55';

  constructor(
    private readonly aggregatorService: AggregatorService,
    private readonly http: HttpService,
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

      // Fetch bookmaker fancy and odds for all active matches in parallel via internal endpoints
      const fetchPromises = activeMatches.flatMap((match) => [
        firstValueFrom(
          this.http.get(`${this.internalBaseUrl}/cricketid/bookmaker-fancy`, {
            params: { eventId: match.eventId },
          }),
        ).then(
          (response) => ({
            type: 'fancy' as const,
            eventId: match.eventId,
            success: true,
            data: response.data,
          }),
          (error: any) => ({
            type: 'fancy' as const,
            eventId: match.eventId,
            success: false,
            error: error?.response?.data?.message || error?.message || String(error),
          }),
        ),
        firstValueFrom(
          this.http.get(`${this.internalBaseUrl}/cricketid/odds`, {
            params: { marketIds: match.marketIds },
          }),
        ).then(
          (response) => ({
            type: 'odds' as const,
            marketIds: match.marketIds,
            success: true,
            data: response.data,
          }),
          (error: any) => ({
            type: 'odds' as const,
            marketIds: match.marketIds,
            success: false,
            error: error?.response?.data?.message || error?.message || String(error),
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

  /**
   * Separate cron job specifically for bookmaker-fancy endpoint
   * Runs every 3 seconds for all active matches
   */
  @Cron('*/3 * * * * *') // Every 3 seconds
  async fetchBookmakerFancy() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      
      if (activeMatches.length === 0) {
        return;
      }

      // Fetch bookmaker fancy for all active matches in parallel via internal endpoint
      const fetchPromises = activeMatches.map((match) =>
        firstValueFrom(
          this.http.get(`${this.internalBaseUrl}/cricketid/bookmaker-fancy`, {
            params: { eventId: match.eventId },
          }),
        ).then(
          (response) => ({
            eventId: match.eventId,
            success: true,
            data: response.data,
          }),
          (error: any) => ({
            eventId: match.eventId,
            success: false,
            error: error?.response?.data?.message || error?.message || String(error),
          }),
        ),
      );

      const results = await Promise.all(fetchPromises);

      // Log results
      results.forEach((result) => {
        if (result.success) {
          this.logger.debug(`Successfully fetched bookmaker fancy for eventId ${result.eventId}`);
        } else {
          const errorMsg = 'error' in result ? result.error : 'Unknown error';
          this.logger.warn(`Failed to fetch bookmaker fancy for eventId ${result.eventId}: ${errorMsg}`);
        }
      });

      this.logger.debug(`Fetched bookmaker fancy for ${activeMatches.length} active matches`);
    } catch (error) {
      this.logger.error(
        'Error in bookmaker fancy cron job:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

