import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';
import { MatchVisibilityService } from './match-visibility.service';
import { RedisService } from '../common/redis/redis.service';
import { CricketIdService } from './cricketid.service';

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);
  private readonly baseUrl = 'https://72.61.140.55';
  private cache = new Map<string, { data: any; expiresAt: number }>();
  private activeMatches = new Map<string, { eventId: string; marketIds: string; lastAccessed: number }>();

  // ✅ PERFORMANCE: Redis TTLs (in seconds)
  private readonly REDIS_TTL = {
    VENDOR_MATCH_DETAIL: 10,  // 10 seconds (match details change less frequently)
  };

  constructor(
    private readonly http: HttpService,
    private readonly matchVisibilityService: MatchVisibilityService,
    private readonly redisService: RedisService, // ✅ PERFORMANCE: Redis for vendor data caching
    private readonly cricketIdService: CricketIdService, // ✅ PERFORMANCE: For fetching vendor data in cron
  ) {
    // Clean up expired cache entries every 5 minutes
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
    // Clean up inactive matches (not accessed in last 5 minutes)
    setInterval(() => this.cleanInactiveMatches(), 5 * 60 * 1000);
  }

  private cleanExpiredCache() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.expiresAt <= now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} expired cache entries`);
    }
  }

  private cleanInactiveMatches() {
    const now = Date.now();
    const inactiveThreshold = 5 * 60 * 1000; // 5 minutes
    let cleaned = 0;
    for (const [key, match] of this.activeMatches.entries()) {
      if (now - match.lastAccessed > inactiveThreshold) {
        this.activeMatches.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} inactive matches`);
    }
  }

  /**
   * Register an active match for cache pre-fetching
   */
  registerActiveMatch(eventId: string, marketIds: string) {
    const key = `${eventId}:${marketIds}`;
    const existing = this.activeMatches.get(key);
    this.activeMatches.set(key, {
      eventId,
      marketIds,
      lastAccessed: Date.now(),
    });
    if (!existing) {
      this.logger.debug(`Registered new active match: ${key}`);
    }
  }

  /**
   * Get all active matches
   */
  getActiveMatches(): Array<{ eventId: string; marketIds: string }> {
    return Array.from(this.activeMatches.values()).map(({ eventId, marketIds }) => ({
      eventId,
      marketIds,
    }));
  }

  /**
   * Pre-fetch and refresh cache for a specific match
   * Forces a refresh by directly fetching (bypasses cache check)
   */
  async refreshMatchCache(eventId: string, marketIds: string) {
    try {
      const now = Date.now();
      
      // Force refresh by directly fetching and updating cache
      const [fancyResult, oddsResult] = await Promise.allSettled([
        this.fetch('/v3/bookmakerFancy', { eventId })
          .then((data) => {
            // Update cache directly
            this.cache.set(`fancy:${eventId}`, { data, expiresAt: now + 2_000 });
            return data;
          }),
        this.fetch('/v3/betfairOdds', { marketIds })
          .then((data) => {
            // Update cache directly
            this.cache.set(`odds:${marketIds}`, { data, expiresAt: now + 1_500 });
            return data;
          }),
      ]);

      if (fancyResult.status === 'rejected') {
        this.logger.warn(`Failed to refresh fancy cache for eventId ${eventId}:`, fancyResult.reason);
      }
      if (oddsResult.status === 'rejected') {
        this.logger.warn(`Failed to refresh odds cache for marketIds ${marketIds}:`, oddsResult.reason);
      }
    } catch (error) {
      this.logger.error(`Error refreshing cache for match ${eventId}:`, error);
    }
  }

  private async fetchWithCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const data = await fetcher();
    this.cache.set(key, { data, expiresAt: now + ttlMs });
    return data;
  }

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    try {
      const { data } = await firstValueFrom(
        this.http.get<T>(url, {
          params,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
          headers: { host: 'vendorapi.tresting.com' }, // or the host given by the provider
        }),
      );
      return data;
    } catch (error: any) {
      // Extract detailed error information
      const status = error?.response?.status;
      const errorDetails = {
        url,
        params,
        status,
        statusText: error?.response?.statusText,
        message: error?.message || String(error),
        responseData: error?.response?.data,
        code: error?.code,
      };
      
      // For 400 errors (invalid/expired IDs), only log in debug mode
      // These are expected when competitionId/eventId is invalid or expired
      if (status === 400) {
        if (process.env.NODE_ENV === 'development') {
          this.logger.debug(
            `Vendor API returned 400 for ${url} - Invalid or expired resource`,
            { params, competitionId: params.competitionId || params.eventId },
          );
        }
      } else {
        // For other errors (5xx, network errors, etc.), log as error
        this.logger.error(`Error fetching ${url}:`, JSON.stringify(errorDetails, null, 2));
      }
      
      // Create a more informative error
      const enhancedError = new Error(
        `API request failed: ${errorDetails.message}${status ? ` (Status: ${status})` : ''}`,
      );
      (enhancedError as any).details = errorDetails;
      throw enhancedError;
    }
  }

  /**
   * Get all competitions (Cricket = sportId: 4)
   * Endpoint: /cricketid/series?sportId={sportId}
   * @param sportId - Sport ID (default: '4' for cricket)
   */
  async getCompetitions(sportId: string = '4') {
    try {
      const response = await this.fetch<any[]>(`/cricketid/series`, { sportId });
      // the API already returns an array
      return Array.isArray(response) ? response : [];
    } catch (error) {
      this.logger.error(`Error fetching competitions for sportId ${sportId}:`, error);
      throw error;
    }
  }

  /**
   * Get matches for each competition
   * Endpoint: /cricketid/matches?competitionId={competitionId}
   * @param competitionId - Competition ID
   */
  async getMatchesByCompetition(competitionId: string) {
    try {
      const response = await this.fetch<any[]>(`/cricketid/matches`, { competitionId });
      const matches = Array.isArray(response) ? response : [];

      // Sync matches with visibility table (create if not exists)
      // Use batch sync to prevent connection pool exhaustion
      const eventIds = matches
        .map((match) => match?.event?.id)
        .filter((id): id is string => !!id);
      
      if (eventIds.length > 0) {
        // Batch sync all matches in a single transaction (prevents connection pool exhaustion)
        this.matchVisibilityService.syncMatchesBatch(eventIds).catch((err) => {
          this.logger.debug(`Failed to batch sync ${eventIds.length} matches:`, err);
        });
      }

      return matches;
    } catch (error: any) {
      // Check if this is a 400 error (invalid/expired competitionId) - expected scenario
      const status = error?.details?.status;
      if (status === 400) {
        // Log as debug/warn instead of error - these are expected when competitionIds are expired/invalid
        this.logger.debug(
          `CompetitionId ${competitionId} is invalid or expired (expected): ${error?.message || 'Invalid resource'}`,
        );
      } else {
        // Log other errors (5xx, network errors, etc.) as errors
        this.logger.error(`Error fetching matches for competitionId ${competitionId}:`, error);
      }
      return []; // return empty array on error to continue
    }
  }

  /**
   * Fetch all cricket matches and classify Live / Upcoming
   * Filters matches by admin-controlled visibility settings
   * @param sportId - Sport ID (default: '4' for cricket)
   * @param page - Page number (for cache key differentiation)
   * @param per_page - Items per page (for cache key differentiation)
   */
  async getAllCricketMatches(sportId = '4', page = 1, per_page = 20) {
    return this.fetchWithCache(
      `cricket:${sportId}:${page}:${per_page}`,
      30_000, // cache for 30 seconds
      async () => {
        const competitions = await this.getCompetitions(sportId);

        const allMatches: any[] = [];

        for (const competition of competitions) {
          const compId = competition?.competition?.id;
          if (!compId) continue;

          const matches = await this.getMatchesByCompetition(compId);
          allMatches.push(...matches);
        }

        // Extract eventIds and get visibility map
        const eventIds = allMatches
          .map((m) => m?.event?.id)
          .filter((id): id is string => !!id);

        const visibilityMap = await this.matchVisibilityService.getVisibilityMap(eventIds);

        // Filter matches by visibility (only show enabled matches)
        const visibleMatches = this.matchVisibilityService.filterMatchesByVisibility(
          allMatches,
          visibilityMap,
        );

        // Classify by date
        const live = visibleMatches.filter((m) => new Date(m?.event?.openDate) <= new Date());
        const upcoming = visibleMatches.filter((m) => new Date(m?.event?.openDate) > new Date());

        return {
          total: visibleMatches.length,
          // all: allMatches,
          live,
          upcoming,
        };
      },
    );
  }

  /**
   * Match detail (markets)
   * Endpoint: /cricketid/markets?eventId={eventId}
   * 
   * ✅ PERFORMANCE: Reads from Redis cache first, falls back to vendor API if cache miss
   * 
   * @param eventId - Event ID
   */
  async getMatchDetail(eventId: string) {
    // ✅ PERFORMANCE: Try Redis cache first
    const cacheKey = this.redisService.getVendorKey('match-detail', eventId);
    const cached = await this.redisService.get<any>(cacheKey);
    if (cached) {
      this.logger.debug(`Redis cache HIT for match-detail: ${eventId}`);
      return cached;
    }

    // Cache miss - fetch from vendor API (original logic unchanged)
    this.logger.debug(`Redis cache MISS for match-detail: ${eventId} - fetching from vendor API`);
    try {
      const response = await this.fetch('/cricketid/markets', { eventId });
      
      // ✅ PERFORMANCE: Store in Redis for future requests (await to ensure it's set)
      try {
        await this.redisService.set(cacheKey, response, this.REDIS_TTL.VENDOR_MATCH_DETAIL);
        this.logger.debug(`Redis cache SET for match-detail: ${eventId} (TTL: ${this.REDIS_TTL.VENDOR_MATCH_DETAIL}s)`);
      } catch (error) {
        // Log but don't fail - cache is optional
        this.logger.warn(`Failed to set Redis cache for match-detail ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      return response;
    } catch (error: any) {
      // Check if this is a 400 error (invalid/expired eventId) - expected scenario
      const status = error?.details?.status;
      if (status === 400) {
        // Log as debug instead of error - these are expected when eventIds are expired/invalid
        this.logger.debug(
          `EventId ${eventId} is invalid or expired (expected): ${error?.message || 'Invalid resource'}`,
        );
      } else {
        // Log other errors (5xx, network errors, etc.) as errors
        this.logger.error(`Error fetching match detail for eventId ${eventId}:`, error);
      }
      throw error;
    }
  }

  /**
   * Get bookmaker fancy for a match
   */
  async getFancy(eventId: string) {
    return this.fetchWithCache(
      `fancy:${eventId}`,
      2_000, // cache 2 seconds
      async () => {
        return this.fetch('/v3/bookmakerFancy', { eventId });
      },
    );
  }

  /**
   * Get match odds
   */
  async getOdds(marketIds: string) {
    return this.fetchWithCache(
      `odds:${marketIds}`,
      1_500, // cache 1.5 seconds
      async () => {
        return this.fetch('/v3/betfairOdds', { marketIds });
      },
    );
  }

  /**
   * Get both odds and fancy merged together
   */
  async getOddsAndFancy(eventId: string, marketIds: string) {
    // Register this match as active for cache pre-fetching
    this.registerActiveMatch(eventId, marketIds);

    // Fetch fancy and odds concurrently
    const [fancyResult, oddsResult] = await Promise.allSettled([
      this.getFancy(eventId),
      this.getOdds(marketIds),
    ]);

    // Extract results or null
    const fancy = fancyResult.status === 'fulfilled' ? fancyResult.value : null;
    const odds = oddsResult.status === 'fulfilled' ? oddsResult.value : null;

    // Determine if the data is actually present
    const hasFancy = fancy && Object.keys(fancy).length > 0;
    const hasOdds = odds && typeof odds === 'object' && 'data' in odds && Array.isArray((odds as any).data) && (odds as any).data.length > 0;

    // Capture errors for logging
    const fancyError =
      fancyResult.status === 'rejected'
        ? {
            message:
              fancyResult.reason instanceof Error
                ? fancyResult.reason.message
                : String(fancyResult.reason),
            details: (fancyResult.reason as any)?.details || null,
          }
        : null;

    const oddsError =
      oddsResult.status === 'rejected'
        ? {
            message:
              oddsResult.reason instanceof Error
                ? oddsResult.reason.message
                : String(oddsResult.reason),
            details: (oddsResult.reason as any)?.details || null,
          }
        : null;

    // Log warnings if upstream had issues or empty data
    if (!hasFancy) {
      this.logger.warn(
        `No fancy data available for eventId ${eventId}` +
          (fancyError ? `: ${JSON.stringify(fancyError)}` : '')
      );
    }
    if (!hasOdds) {
      this.logger.warn(
        `No odds data available for marketIds ${marketIds}` +
          (oddsError ? `: ${JSON.stringify(oddsError)}` : '')
      );
    }

    // Return a clean JSON object, never throw
    return {
      eventId,
      marketIds: marketIds.split(','),
      fancy: hasFancy ? fancy : null,
      odds: hasOdds ? odds : null,
      errors: fancyError || oddsError ? { fancy: fancyError, odds: oddsError } : undefined,
      updatedAt: Date.now(),
    };
  }
}

