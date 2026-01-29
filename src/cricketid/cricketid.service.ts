import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import * as https from 'https';
import * as http from 'http';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class CricketIdService {
  private readonly logger = new Logger(CricketIdService.name);
  private readonly baseUrl = 'https://vendorapi.tresting.com';
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000; // Initial delay in ms
  private readonly timeout = 30000; // 30 seconds timeout

  // ✅ PERFORMANCE: Redis TTLs (in seconds)
  private readonly REDIS_TTL = {
    VENDOR_ODDS: 5,           // 5 seconds (odds change frequently, but 3s was too short)
    VENDOR_FANCY: 5,          // 5 seconds (fancy data changes frequently, but 3s was too short)
    VENDOR_BOOKMAKER: 5,      // 5 seconds (bookmaker data changes frequently, but 3s was too short)
    VENDOR_MATCH_DETAIL: 10,  // 10 seconds (match details change less frequently)
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

    let lastError: any;
    
    // Retry loop
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { data } = await firstValueFrom(
          this.http.get<T>(url, {
            params,
            timeout: this.timeout,
            // Add connection keep-alive and retry settings
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
          }),
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
   * Get all competitions/series for a specific sport
   * Endpoint: /v3/seriesList?sportId={sportId}
   * Returns list of competitions with competition.id, competition.name, etc.
   * @param sportId - Sport ID (4 for cricket)
   */
  async getSeriesList(sportId: number) {
    return this.fetch('/v3/seriesList', { sportId });
  }

  /**
   * Get match details by competition ID
   * Endpoint: /v3/matchList?sportId={sportId}&competitionId={competitionId}
   * @param competitionId - Competition ID from the series list (e.g., "9992899")
   * @param sportId - Sport ID (default: 4 for cricket)
   */
  async getMatchDetails(competitionId: string | number, sportId: number = 4) {
    return this.fetch('/v3/matchList', { 
      sportId,
      competitionId 
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

