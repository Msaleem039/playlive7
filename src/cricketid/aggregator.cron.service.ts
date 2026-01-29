import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AggregatorService } from './aggregator.service';
import { CricketIdService } from './cricketid.service';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class AggregatorCronService {
  private readonly logger = new Logger(AggregatorCronService.name);
  // Internal server base URL - can be moved to environment variable
  private readonly internalBaseUrl = process.env.INTERNAL_API_URL || 'https://72.61.140.55';

  constructor(
    private readonly aggregatorService: AggregatorService,
    private readonly http: HttpService,
    private readonly cricketIdService: CricketIdService, // Inject service directly instead of HTTP calls
    private readonly redisService: RedisService, // ✅ PERFORMANCE: Redis for storing vendor data
  ) {}

  /**
   * ✅ REMOVED: refreshActiveMatchesCache() cron job
   * 
   * REASON FOR REMOVAL:
   * - Match detail (markets) should be fetched on-demand only, not via cron
   * - getMatchDetail() already has Redis caching and is called from API endpoints
   * - This cron was using in-memory Map cache, bypassing Redis
   * - Removing this eliminates duplicate vendor API calls
   * 
   * LOGIC PRESERVATION:
   * - getMatchDetail() is still available via API endpoints:
   *   - GET /cricketid/aggregator/match/:eventId
   *   - Called from positions.controller.ts (on-demand)
   *   - Called from settlement.service.ts (on-demand)
   * - All calls use Redis caching (10-second TTL)
   * - No business logic affected - only removed unnecessary cron polling
   */

  @Cron('*/4 * * * * *') // Every 4 seconds
  async fetchBookmakerFancyAndOdds() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      
      if (activeMatches.length === 0) {
        return;
      }

      // ✅ PERFORMANCE: Fetch vendor data and store in Redis (background job)
      // This pre-warms Redis cache so user requests are fast
      const fetchPromises = activeMatches.flatMap((match) => [
        // Call service directly - it will cache in Redis automatically
        this.cricketIdService.getBookmakerFancy(match.eventId)
          .then((response) => {
            // Response structure: { success, msg, status, data: [...] }
            // data array contains only filtered markets: Normal, MATCH_ODDS, Bookmaker, TIED_MATCH
            // ✅ PERFORMANCE: Response is already cached in Redis by cricketIdService
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
        // Fetch odds and cache in Redis
        this.cricketIdService.getBetfairOdds(match.marketIds)
          .then((response) => {
            // ✅ PERFORMANCE: Response is already cached in Redis by cricketIdService
            return {
              type: 'odds' as const,
              marketIds: match.marketIds,
              success: true,
              data: response,
            };
          })
          .catch((error: any) => ({
            type: 'odds' as const,
            marketIds: match.marketIds,
            success: false,
            error: error?.message || String(error),
          })),
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
   * ✅ REMOVED: fetchBookmakerFancy() cron job
   * 
   * REASON FOR REMOVAL:
   * - This is a DUPLICATE of fetchBookmakerFancyAndOdds()
   * - fetchBookmakerFancyAndOdds() already fetches bookmaker fancy + odds every 4 seconds
   * - Removing this eliminates duplicate vendor API calls for the same data
   * 
   * LOGIC PRESERVATION:
   * - fetchBookmakerFancyAndOdds() still runs every 4 seconds
   * - It fetches bookmaker fancy using cricketIdService.getBookmakerFancy()
   * - cricketIdService.getBookmakerFancy() uses Redis caching (3-second TTL)
   * - API endpoint GET /cricketid/bookmaker-fancy still works (on-demand, uses Redis)
   * - No business logic affected - only removed redundant cron job
   */
}

