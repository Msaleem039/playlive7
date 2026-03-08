import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import * as https from 'https';
import * as http from 'http';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class CricketIdService {
  private readonly logger = new Logger(CricketIdService.name);
  
  // ✅ MULTI-SPORT: Supported sport IDs
  // 1 = Soccer, 2 = Tennis, 4 = Cricket
  private readonly DEFAULT_SPORT_ID = 4; // Cricket (backward compatibility)
  private readonly baseUrl = 'https://vendorapi.tresting.com';
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000; // Initial delay in ms
  private readonly timeout = 30000; // 30 seconds timeout

  /**
   * Redis TTLs (in seconds) – betting-platform data refresh model.
   * Short TTLs keep live data responsive; longer TTLs reduce vendor API load for stable data.
   */
  private readonly REDIS_TTL = {
    // Odds / Fancy / Bookmaker → very frequent updates (prices move in real time)
    VENDOR_ODDS: 4,       // 4s: Betfair odds change constantly; short TTL for accurate live betting.
    VENDOR_FANCY: 4,      // 4s: Fancy markets update frequently; balance freshness vs API load.
    VENDOR_BOOKMAKER: 4,  // 4s: Bookmaker lines move often; keep cache brief for responsiveness.

    // Market / Match details → medium update frequency (markets open/close, status changes)
    VENDOR_MATCH_DETAIL: 12, // 12s: Market list and match metadata; less volatile than odds.

    // Match list per competition → occasional updates (new matches, start times, cancellations)
    MATCH_LIST: 180, // 3 min: List of matches in a competition changes occasionally.

    // Series list / competitions → rarely change (tournament structure is static for the season)
    SERIES_LIST: 600, // 10 min: Competitions/series list changes rarely; longer TTL cuts API calls.
  };

  constructor(
    private readonly http: HttpService,
    private readonly redisService: RedisService, // ✅ PERFORMANCE: Redis for vendor data caching
  ) {}

  /**
   * Check if error is a transient network error that should be retried
   */
  private isRetryableError(error: any): boolean {
    if (!(error instanceof AxiosError)) {
      return false;
    }

    const code = error.code;
    const message = error.message?.toLowerCase() || '';

    // Network errors that should be retried
    const retryableCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNABORTED',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ];

    // Check error code
    if (code && retryableCodes.includes(code)) {
      return true;
    }

    // Check error message for network-related errors
    if (
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('connection')
    ) {
      return true;
    }

    // Retry on 5xx server errors (but not 4xx client errors)
    if (error.response?.status && error.response.status >= 500) {
      return true;
    }

    return false;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    // When path already has query string (e.g. matchList?sportId=X?competition=Y), do not pass
    // params so Axios uses the URL as-is. Otherwise Axios can re-serialize and turn ? into &.
    const requestConfig: any = {
      timeout: this.timeout,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PlayLive-API/1.0',
      },
      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: this.timeout,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: this.timeout,
      }),
    };
    if (!normalizedPath.includes('?')) {
      requestConfig.params = params;
    }
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { data } = await firstValueFrom(
          this.http.get<T>(url, requestConfig),
        );
        return data;
      } catch (error) {
        lastError = error;

        // Check if error is retryable and we haven't exceeded max retries
        if (attempt < this.maxRetries && this.isRetryableError(error)) {
          const delay = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
          const errorCode = error instanceof AxiosError ? error.code : 'UNKNOWN';
          
          this.logger.warn(
            `Vendor API request failed (attempt ${attempt + 1}/${this.maxRetries + 1}) for ${url}: ${errorCode}. Retrying in ${delay}ms...`,
            {
              url,
              params,
              errorCode,
              attempt: attempt + 1,
              maxRetries: this.maxRetries,
            },
          );

          await this.sleep(delay);
          continue; // Retry the request
        }

        // If not retryable or max retries exceeded, handle the error
        if (error instanceof AxiosError) {
          const status = error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR;
          const responseData = error.response?.data;
          const requestParams = JSON.stringify(params);
          
          // For 400 errors (invalid/expired IDs), log as debug instead of warning
          // This is expected behavior when competitionId/eventId is invalid or expired
          // Only log in debug mode to reduce log noise
          if (status === 400) {
            // Only log in debug mode - these are expected errors
            if (process.env.NODE_ENV === 'development') {
              this.logger.debug(
                `Vendor API returned 400 for ${url} - Invalid or expired resource`,
                { params, eventId: params.eventId || params.competitionId },
              );
            }
            
            const errorMessage = 
              responseData?.message || 
              responseData?.error || 
              `Invalid request parameters. Check if competitionId/eventId is valid and not expired.`;
            
            throw new HttpException(
              {
                statusCode: status,
                message: errorMessage,
                error: 'Vendor API Error',
                details: {
                  ...responseData,
                  params,
                  suggestion: 'The requested resource may be invalid, expired, or no longer available from the vendor API.',
                },
              },
              status,
            );
          }
          
          // For network errors after retries, provide more context
          const isNetworkError = this.isRetryableError(error);
          const logLevel = isNetworkError ? 'error' : 'error';
          
          this.logger[logLevel](
            `Vendor API Error [${status}] for ${url} with params: ${requestParams}${isNetworkError ? ` (after ${this.maxRetries + 1} attempts)` : ''}`,
            {
              url,
              params,
              status,
              statusText: error.response?.statusText,
              responseData,
              message: error.message,
              code: error.code,
              attempts: attempt + 1,
            },
          );
          
          const message = isNetworkError
            ? `Network error: ${error.message || 'Connection failed'} (after ${this.maxRetries + 1} attempts)`
            : responseData?.message || error.message || 'Failed to fetch data from vendor API';
          
          throw new HttpException(
            {
              statusCode: status,
              message,
              error: 'Vendor API Error',
              details: {
                ...(responseData || {}),
                code: error.code,
                attempts: attempt + 1,
                retryable: isNetworkError,
              },
            },
            status,
          );
        }
        
        // Non-Axios errors
        this.logger.error(
          `Unexpected error fetching ${url} with params: ${JSON.stringify(params)}:`,
          error instanceof Error ? error.stack : String(error),
        );
        
        throw new HttpException(
          {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Internal server error',
            error: 'Internal Server Error',
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    // If we get here, all retries failed
    throw lastError;
  }

  /**
   * Get all sports/events
   * Endpoint: /v3/eventList
   */
  async getAllSports() {
    return this.fetch('/v3/eventList');
  }

  /**
   * Normalize vendor response to an array (handles raw array, wrapper objects, and one level of nesting).
   */
  private normalizeToArray<T = any>(raw: unknown, dataKeys: string[] = ['data', 'matches', 'series']): T[] {
    if (Array.isArray(raw)) {
      return raw as T[];
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      for (const key of dataKeys) {
        const val = obj[key];
        if (Array.isArray(val)) {
          return val as T[];
        }
        // One level of nesting: e.g. { data: { series: [...] } }
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const inner = val as Record<string, unknown>;
          for (const innerKey of dataKeys) {
            if (Array.isArray(inner[innerKey])) {
              return inner[innerKey] as T[];
            }
          }
        }
      }
    }
    return [];
  }

  /**
   * Get all competitions/series (leagues) for a specific sport
   * Endpoint: /v3/seriesList?sportId={sportId}
   * Returns array of { competition: { id, name }, competitionRegion, marketCount } etc.
   * ✅ MULTI-SPORT: Supports Soccer (1), Tennis (2), Cricket (4)
   * @param sportId - Sport ID (1=Soccer, 2=Tennis, 4=Cricket, default: 4)
   */
  async getSeriesList(sportId: number = this.DEFAULT_SPORT_ID) {
    // Build URL manually so vendor gets exact format (same pattern as matchList)
    const url = `/v3/seriesList?sportId=${sportId}`;
    const raw = await this.fetch(url);
    // Vendor may return a raw array of { competition, competitionRegion, marketCount }; return as-is
    return this.normalizeToArray(raw, ['data', 'series', 'competitions', 'list', 'result', 'items']);
  }

  /**
   * Get match list for a competition (by competition ID from series list)
   * Vendor: /v3/matchList?sportId={sportId}&competition={competitionId}
   * Returns array of matches; each item includes eventId for use with /markets and /bookmaker-fancy.
   * ✅ MULTI-SPORT: Supports Soccer (1), Tennis (2), Cricket (4)
   * @param competitionId - Competition ID from the series list (e.g. "12597512")
   * @param sportId - Sport ID (1=Soccer, 2=Tennis, 4=Cricket, default: 4)
   */
  async getMatchDetails(competitionId: string | number, sportId: number = this.DEFAULT_SPORT_ID) {
    const comp = String(competitionId);
    let raw: unknown;
    try {
      // Vendor API expects non-standard format: ?sportId=X?competition=Y (not &)
      const url = `/v3/matchList?sportId=${sportId}?competition=${comp}`;
      raw = await this.fetch(url);
    } catch (error: any) {
      const status = error?.response?.status ?? error?.statusCode ?? error?.getStatus?.();
      if (status === 400) {
        this.logger.debug(
          `Vendor returned 400 for matchList (sportId=${sportId}, competitionId=${comp}); returning empty list`,
        );
        return [];
      }
      throw error;
    }
    const matches = this.normalizeToArray<any>(raw, ['data', 'matches', 'events', 'eventList']);
    const now = new Date();
    return matches.map((match) => {
      const eventId = match?.event?.id ?? match?.eventId;
      const openDate = match?.event?.openDate;
      const hasStarted = openDate ? new Date(openDate) <= now : false;
      return {
        ...match,
        ...(eventId != null && String(eventId).trim() !== '' ? { eventId: String(eventId) } : {}),
        live: hasStarted,
        upcoming: openDate ? !hasStarted : false,
      };
    });
  }

  /**
   * Validate that the sportId is supported for VendorService (Soccer/Tennis only).
   * Allowed sportIds:
   *  - 1: Soccer
   *  - 2: Tennis
   * Any other value will throw BadRequestException.
   */
  private validateSport(sportId: number) {
    if (sportId !== 1 && sportId !== 2) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid sportId. Only Soccer (1) and Tennis (2) are supported by this endpoint.',
        error: 'Bad Request',
        details: {
          sportId,
          allowedSportIds: [1, 2],
        },
      });
    }
  }

  /**
   * Get series list from Redis cache or vendor API (Soccer/Tennis only).
   * Cache key: vendor:series:{sportId}
   * TTL: 30 seconds
   */
  private async getCachedSeries(sportId: number) {
    this.validateSport(sportId);

    const cacheKey = `vendor:series:${sportId}`;
    const cached = await this.redisService.get<any[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Redis cache HIT for series list (sportId=${sportId})`);
      return cached;
    }

    this.logger.debug(`Redis cache MISS for series list (sportId=${sportId}) - fetching from vendor API`);
    const seriesList = await this.getSeriesList(sportId);

    try {
      await this.redisService.set(cacheKey, seriesList, this.REDIS_TTL.SERIES_LIST);
      this.logger.debug(
        `Redis cache SET for series list (sportId=${sportId}) (TTL: ${this.REDIS_TTL.SERIES_LIST}s)`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to set Redis cache for series list sportId=${sportId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return seriesList;
  }

  /**
   * Get match list for a competition from Redis cache or vendor API (Soccer/Tennis only).
   * Cache key: vendor:matches:{sportId}:{competitionId}
   * TTL: 15 seconds
   */
  private async getCachedMatches(sportId: number, competitionId: string) {
    this.validateSport(sportId);

    const cacheKey = `vendor:matches:${sportId}:${competitionId}`;
    const cached = await this.redisService.get<any[]>(cacheKey);
    if (cached) {
      this.logger.debug(
        `Redis cache HIT for match list (sportId=${sportId}, competitionId=${competitionId})`,
      );
      return cached;
    }

    this.logger.debug(
      `Redis cache MISS for match list (sportId=${sportId}, competitionId=${competitionId}) - fetching from vendor API`,
    );
    const matchList = await this.getMatchDetails(competitionId, sportId);

    try {
      await this.redisService.set(cacheKey, matchList, this.REDIS_TTL.MATCH_LIST);
      this.logger.debug(
        `Redis cache SET for match list (sportId=${sportId}, competitionId=${competitionId}) (TTL: ${this.REDIS_TTL.MATCH_LIST}s)`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to set Redis cache for match list sportId=${sportId}, competitionId=${competitionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return matchList;
  }

  /**
   * Get top N matches for a given sport (Soccer/Tennis only).
   * - Supported sports: 1 (Soccer), 2 (Tennis)
   * - Cricket (4) must not be handled here.
   * - Uses Redis caching for series and match lists.
   * - Stops iterating once `limit` matches are collected (early break).
   */
  async getTopMatchesBySport(sportId: number, limit = 5) {
    this.validateSport(sportId);

    const max = Math.max(1, limit || 5);
    const rawSeries = await this.getCachedSeries(sportId);
    const seriesList: any[] = Array.isArray(rawSeries) ? rawSeries : [];

    const allMatches: any[] = [];

    for (const series of seriesList) {
      // Handle both flat and nested competition structures
      const compId =
        (series?.competition && series.competition.id) ||
        series?.id ||
        series?.competitionId ||
        null;

      if (!compId) {
        this.logger.debug(
          `Skipping series with missing competitionId for sportId=${sportId}`,
        );
        continue;
      }

      let matches: any[] = [];
      try {
        const result = await this.getCachedMatches(sportId, String(compId));
        matches = Array.isArray(result) ? result : [];
      } catch (error: any) {
        // Skip invalid/expired competitions (400) and continue to next
        const status = error?.getStatus?.() ?? error?.statusCode ?? error?.response?.status;
        if (status === 400) {
          this.logger.debug(
            `Skipping invalid/expired competitionId ${compId} for sportId=${sportId}`,
          );
        } else {
          throw error;
        }
      }

      if (matches.length > 0) {
        allMatches.push(...matches);
      }

      if (allMatches.length >= max) {
        this.logger.debug(
          `Collected ${allMatches.length} matches for sportId=${sportId}, stopping early at limit=${max}`,
        );
        break;
      }
    }

    const result = allMatches.slice(0, max);
    const now = new Date();
    return result.map((match) => {
      const openDate = match?.event?.openDate;
      const hasStarted = openDate ? new Date(openDate) <= now : false;
      return {
        ...match,
        live: hasStarted,
        upcoming: openDate ? !hasStarted : false,
      };
    });
  }

  /**
   * Get market list (odds/markets) for a specific event/match
   * Endpoint: /v3/marketList?eventId={eventId}
   * Returns markets with runners, odds, selectionId, etc.
   * 
   * ✅ PERFORMANCE: Reads from Redis cache first, falls back to vendor API if cache miss
   * 
   * @param eventId - Event ID from the match list (e.g., "34917574")
   */
  async getMarketList(eventId: string | number) {
    // ✅ PERFORMANCE: Try Redis cache first
    const cacheKey = this.redisService.getVendorKey('market-list', String(eventId));
    const cached = await this.redisService.get<any>(cacheKey);
    if (cached) {
      this.logger.debug(`Redis cache HIT for market-list: ${eventId}`);
      return cached;
    }

    // Cache miss - fetch from vendor API (original logic unchanged)
    this.logger.debug(`Redis cache MISS for market-list: ${eventId} - fetching from vendor API`);
    const response = await this.fetch('/v3/marketList', { eventId });
    
    // ✅ PERFORMANCE: Store in Redis for future requests (await to ensure it's set)
    try {
      await this.redisService.set(cacheKey, response, this.REDIS_TTL.VENDOR_MATCH_DETAIL);
      this.logger.debug(`Redis cache SET for market-list: ${eventId} (TTL: ${this.REDIS_TTL.VENDOR_MATCH_DETAIL}s)`);
    } catch (error) {
      // Log but don't fail - cache is optional
      this.logger.warn(`Failed to set Redis cache for market-list ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return response;
  }

  /**
   * Get markets for a specific match/event.
   * Reuses existing getMarketList() with Redis caching.
   */
  async getMatchMarkets(eventId: string) {
    return this.getMarketList(eventId);
  }

  /**
   * Get Betfair odds for specific markets
   * Endpoint: /v3/betfairOdds?marketIds={marketIds}
   * Returns detailed odds data including availableToBack, availableToLay, etc.
   * 
   * ✅ PERFORMANCE: Reads from Redis cache first, falls back to vendor API if cache miss
   * 
   * @param marketIds - Comma-separated market IDs (e.g., "1.250049502,1.250049500")
   */
  async getBetfairOdds(marketIds: string) {
    // ✅ PERFORMANCE: Try Redis cache first
    // Use consistent key format with getVendorKey()
    const cacheKey = this.redisService.getVendorKey('odds', marketIds);
    const cached = await this.redisService.get<any>(cacheKey);
    if (cached) {
      this.logger.debug(`Redis cache HIT for odds: ${marketIds}`);
      return cached;
    }

    // Cache miss - fetch from vendor API (original logic unchanged)
    this.logger.debug(`Redis cache MISS for odds: ${marketIds} - fetching from vendor API`);
    const response = await this.fetch('/v3/betfairOdds', { marketIds });
    
    // ✅ PERFORMANCE: Store in Redis for future requests (await to ensure it's set)
    try {
      await this.redisService.set(cacheKey, response, this.REDIS_TTL.VENDOR_ODDS);
      this.logger.debug(`Redis cache SET for odds: ${marketIds} (TTL: ${this.REDIS_TTL.VENDOR_ODDS}s)`);
    } catch (error) {
      // Log but don't fail - cache is optional
      this.logger.warn(`Failed to set Redis cache for odds ${marketIds}: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    return response;
  }


  /**
   * Get bookmaker fancy for a specific event
   * Endpoint: /v3/bookmakerFancy?eventId={eventId}
   * Returns bookmaker fancy data with markets, sections, odds, etc.
   * Data is sorted in the following order:
   * 1. bookmakerfancy (Bookmaker, Bookmaker 2)
   * 2. tie match (Tied Match, TIED_MATCH)
   * 3. normal fancy (all other fancy types)
   * 
   * Excluded markets:
   * - MATCH_ODDS
   * - Markets containing "bhav" in the name (case-insensitive)
   * 
   * ✅ PERFORMANCE: Reads from Redis cache first, falls back to vendor API if cache miss
   * 
   * @param eventId - Event ID (e.g., "34917574")
   */
  async getBookmakerFancy(eventId: string | number) {
    // ✅ PERFORMANCE: Try Redis cache first
    const cacheKey = this.redisService.getVendorKey('bookmaker-fancy', String(eventId));
    const cached = await this.redisService.get<{
      success: boolean;
      msg: string;
      status: number;
      data: Array<{
        mname: string;
        gtype: string;
        [key: string]: any;
      }>;
    }>(cacheKey);
    
    if (cached) {
      this.logger.debug(`Redis cache HIT for bookmaker-fancy: ${eventId}`);
      return cached;
    }

    // Cache miss - fetch from vendor API (original logic unchanged)
    this.logger.debug(`Redis cache MISS for bookmaker-fancy: ${eventId} - fetching from vendor API`);
    const response = await this.fetch<{
      success: boolean;
      msg: string;
      status: number;
      data: Array<{
        mname: string;
        gtype: string;
        [key: string]: any;
      }>;
    }>('/v3/bookmakerFancy', { eventId });

    // Sort the data array according to the required sequence
    // Note: MATCH_ODDS will be sorted but filtered out later
    if (response && response.data && Array.isArray(response.data)) {
      response.data.sort((a, b) => {
        // Helper function to get sort priority
        const getPriority = (item: { mname: string; gtype: string }): number => {
          const mname = item.mname?.toUpperCase() || '';
          const gtype = item.gtype?.toLowerCase() || '';

          // 1. match_odds (MATCH_ODDS) - will be filtered out later
          if (mname === 'MATCH_ODDS') {
            return 1;
          }

          // 3. tie match (Tied Match, TIED_MATCH) - check this before bookmakerfancy
          if (mname.includes('TIED')) {
            return 3;
          }

          // 2. bookmakerfancy (Bookmaker, Bookmaker 2, or gtype match1 that's not Tied Match)
          if (mname.includes('BOOKMAKER') || (gtype === 'match1' && !mname.includes('TIED'))) {
            return 2;
          }

          // 4. normal fancy (all other types)
          return 4;
        };

        const priorityA = getPriority(a);
        const priorityB = getPriority(b);

        // If priorities are different, sort by priority
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }

        // If priorities are the same, maintain original order (stable sort)
        // You can also sort by sno if available for sub-ordering within same priority
        const snoA = a.sno || 0;
        const snoB = b.sno || 0;
        return snoA - snoB;
      });

      // Filter to ONLY include these exact market names (all others are skipped):
      // - "Normal"
      // - "Bookmaker"
      // - "TIED_MATCH"
      // Excludes: 
      // - MATCH_ODDS markets
      // - Sections containing "bhav" in their nat field (case-insensitive)
      response.data = response.data.filter((market) => {
        const mname = market.mname?.toUpperCase() || '';
        const originalMname = market.mname || '';

        // Skip MATCH_ODDS
        if (mname === 'MATCH_ODDS') {
          return false;
        }

        // Skip markets containing "bhav" (case-insensitive)
        if (originalMname.toLowerCase().includes('bhav')) {
          return false;
        }

        // 1. Bookmaker (exact match, case-sensitive)
        if (originalMname === 'Bookmaker') {
          return true;
        }

        // 2. TIED_MATCH (case-insensitive)
        if (mname === 'TIED_MATCH') {
          return true;
        }

        // 3. Normal (exact match, case-sensitive)
        if (originalMname === 'Normal') {
          return true;
        }

        // Exclude all other markets
        return false;
      });

      // Filter out sections containing "bhav" in their nat field (case-insensitive)
      response.data.forEach((market) => {
        if (market.section && Array.isArray(market.section)) {
          market.section = market.section.filter((section) => {
            const nat = section.nat || '';
            // Exclude sections with "bhav" in nat field
            return !nat.toLowerCase().includes('bhav');
          });
        }
      });

      // Add isSuspended field to each market
      response.data.forEach((market) => {
        market.isSuspended = this.isMarketSuspended(market);
      });
    }

    // ✅ PERFORMANCE: Store in Redis for future requests (after all filtering/sorting)
    // Await to ensure cache is set before returning
    try {
      await this.redisService.set(cacheKey, response, this.REDIS_TTL.VENDOR_BOOKMAKER);
      this.logger.debug(`Redis cache SET for bookmaker-fancy: ${eventId} (TTL: ${this.REDIS_TTL.VENDOR_BOOKMAKER}s)`);
    } catch (error) {
      // Log but don't fail - cache is optional
      this.logger.warn(`Failed to set Redis cache for bookmaker-fancy ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return response;
  }

  /**
   * Determine if a market is suspended based on various conditions
   * @param market - Market object with gstatus/status, min, max, odds properties
   * @returns boolean indicating if the market is suspended
   */
  private isMarketSuspended(market: {
    gstatus?: string;
    status?: string;
    min?: number;
    max?: number;
    odds?: Array<{ psid?: number; [key: string]: any }>;
    [key: string]: any;
  }): boolean {
    // Check if gstatus is not ACTIVE (also check status field as fallback)
    const marketStatus = market.gstatus || market.status;
    if (marketStatus && marketStatus !== 'ACTIVE' && marketStatus !== 'OPEN') {
      return true;
    }

    // Check if min or max is <= 0
    if ((market.min !== undefined && market.min <= 0) || (market.max !== undefined && market.max <= 0)) {
      return true;
    }

    // Check if odds array is missing or empty
    if (!market.odds || market.odds.length === 0) {
      return true;
    }

    // Check if all odds have psid === 0
    if (market.odds.every((odd) => odd.psid === 0)) {
      return true;
    }

    return false;
  }

}

