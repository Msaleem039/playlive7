import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AggregatorService } from './aggregator.service';
import { CricketIdService } from './cricketid.service';
import { RedisService } from '../common/redis/redis.service';
import { BettingGateway } from '../betting/betting.gateway';

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
    private readonly bettingGateway: BettingGateway,
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

  @Cron('*/1 * * * * *') // Every 1 second (vendor limits permitting)
  async fetchOddsFast() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      
      if (activeMatches.length === 0) {
        return;
      }

      // Fast lane: odds only (1s). Service still uses Redis caching.
      const fetchPromises = activeMatches.map((match) =>
        this.cricketIdService.getBetfairOdds(match.marketIds)
          .then((response) => {
            const emitted = this.bettingGateway.emitOddsIfChanged(
              match.eventId,
              match.marketIds,
              response,
            );
            return {
              type: 'odds' as const,
              eventId: match.eventId,
              marketIds: match.marketIds,
              success: true,
              emitted,
            };
          })
          .catch((error: any) => ({
            type: 'odds' as const,
            eventId: match.eventId,
            marketIds: match.marketIds,
            success: false,
            error: error?.message || String(error),
          })),
      );

      const results = await Promise.all(fetchPromises);

      // Log results
      results.forEach((result) => {
        if (result.success) {
          this.logger.debug(
            `Fetched odds for eventId=${result.eventId} marketIds=${result.marketIds} (emitted=${
              'emitted' in result ? result.emitted : false
            })`,
          );
        } else {
          const errorMsg = 'error' in result ? result.error : 'Unknown error';
          this.logger.warn(`Failed to fetch odds for marketIds ${result.marketIds}: ${errorMsg}`);
        }
      });

      this.logger.debug(`Fetched odds for ${activeMatches.length} active matches`);
    } catch (error) {
      this.logger.error(
        'Error in odds cron job:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Cron('*/4 * * * * *') // Keep bookmaker/fancy on safer cadence
  async fetchBookmakerFancy() {
    try {
      const activeMatches = this.aggregatorService.getActiveMatches();
      if (activeMatches.length === 0) {
        return;
      }

      const fetchPromises = activeMatches.map((match) =>
        this.cricketIdService.getBookmakerFancy(match.eventId)
          .then((response) => {
            const emitted = this.bettingGateway.emitBookmakerFancyIfChanged(
              match.eventId,
              response,
            );
            const responseData = response?.data || [];
            const marketCount = Array.isArray(responseData) ? responseData.length : 0;
            return {
              eventId: match.eventId,
              success: true,
              emitted,
              marketCount,
            };
          })
          .catch((error: any) => ({
            eventId: match.eventId,
            success: false,
            error: error?.message || String(error),
          })),
      );

      const results = await Promise.all(fetchPromises);
      results.forEach((result) => {
        if (result.success) {
          const marketCount = 'marketCount' in result ? result.marketCount : 0;
          const emitted = 'emitted' in result ? result.emitted : false;
          this.logger.debug(
            `Fetched bookmaker-fancy for eventId=${result.eventId} (markets=${marketCount}, emitted=${emitted})`,
          );
        } else {
          const errorMsg = 'error' in result ? result.error : 'Unknown error';
          this.logger.warn(`Failed to fetch bookmaker-fancy for eventId ${result.eventId}: ${errorMsg}`);
        }
      });
    } catch (error) {
      this.logger.error(
        'Error in bookmaker-fancy cron job:',
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

