import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AggregatorService } from './aggregator.service';
import { CricketIdService } from './cricketid.service';

@Injectable()
export class AggregatorCronService {
  private readonly logger = new Logger(AggregatorCronService.name);
  // Internal server base URL - can be moved to environment variable
  private readonly internalBaseUrl = process.env.INTERNAL_API_URL || 'https://72.61.140.55';

  constructor(
    private readonly aggregatorService: AggregatorService,
    private readonly http: HttpService,
    private readonly cricketIdService: CricketIdService, // Inject service directly instead of HTTP calls
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
      // OPTIMIZED: Call service directly instead of HTTP (same endpoint, better performance)
      // Response is filtered to only include: "Normal", "MATCH_ODDS", "Bookmaker", "TIED_MATCH"
      const fetchPromises = activeMatches.flatMap((match) => [
        // Call service directly (same as /cricketid/bookmaker-fancy endpoint)
        this.cricketIdService.getBookmakerFancy(match.eventId)
          .then((response) => {
            // Response structure: { success, msg, status, data: [...] }
            // data array contains only filtered markets: Normal, MATCH_ODDS, Bookmaker, TIED_MATCH
            const responseData = response?.data || [];
            const marketCount = Array.isArray(responseData) ? responseData.length : 0;
            
            return {
              type: 'fancy' as const,
              eventId: match.eventId,
              success: true,
              data: responseData,
              marketCount, // Number of filtered markets returned
            };
          })
          .catch((error: any) => ({
            type: 'fancy' as const,
            eventId: match.eventId,
            success: false,
            error: error?.message || String(error),
          })),
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
            const marketCount = 'marketCount' in result ? result.marketCount : 'unknown';
            this.logger.debug(
              `Successfully fetched bookmaker fancy for eventId ${result.eventId} (${marketCount} filtered markets: Normal, MATCH_ODDS, Bookmaker, TIED_MATCH)`,
            );
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

      // Fetch bookmaker fancy for all active matches in parallel
      // OPTIMIZED: Call service directly instead of HTTP (same endpoint, better performance)
      // Response is filtered to only include: "Normal", "MATCH_ODDS", "Bookmaker", "TIED_MATCH"
      const fetchPromises = activeMatches.map((match) =>
        // Call service directly (same as /cricketid/bookmaker-fancy endpoint)
        this.cricketIdService.getBookmakerFancy(match.eventId)
          .then((response) => {
            // Response structure: { success, msg, status, data: [...] }
            // data array contains only filtered markets: Normal, MATCH_ODDS, Bookmaker, TIED_MATCH
            const responseData = response?.data || [];
            const marketCount = Array.isArray(responseData) ? responseData.length : 0;
            
            return {
              eventId: match.eventId,
              success: true,
              data: responseData,
              marketCount, // Number of filtered markets returned
            };
          })
          .catch((error: any) => ({
            eventId: match.eventId,
            success: false,
            error: error?.message || String(error),
          })),
      );

      const results = await Promise.all(fetchPromises);

      // Log results
      results.forEach((result) => {
        if (result.success) {
          const marketCount = 'marketCount' in result ? result.marketCount : 'unknown';
          this.logger.debug(
            `Successfully fetched bookmaker fancy for eventId ${result.eventId} (${marketCount} filtered markets: Normal, MATCH_ODDS, Bookmaker, TIED_MATCH)`,
          );
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

