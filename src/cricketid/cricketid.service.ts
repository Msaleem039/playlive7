import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

@Injectable()
export class CricketIdService {
  private readonly logger = new Logger(CricketIdService.name);
  private readonly baseUrl = 'https://vendorapi.tresting.com';

  constructor(private readonly http: HttpService) {}

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    try {
      const { data } = await firstValueFrom(
        this.http.get<T>(url, {
          params,
        }),
      );
      return data;
    } catch (error) {
      // Log detailed error information for debugging
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
        
        // For other errors (5xx, network errors, etc.), log as error
        this.logger.error(
          `Vendor API Error [${status}] for ${url} with params: ${requestParams}`,
          {
            url,
            params,
            status,
            statusText: error.response?.statusText,
            responseData,
            message: error.message,
          },
        );
        
        const message = responseData?.message || error.message || 'Failed to fetch data from vendor API';
        
        throw new HttpException(
          {
            statusCode: status,
            message,
            error: 'Vendor API Error',
            details: responseData || undefined,
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
   * @param eventId - Event ID from the match list (e.g., "34917574")
   */
  async getMarketList(eventId: string | number) {
    return this.fetch('/v3/marketList', { eventId });
  }

  /**
   * Get Betfair odds for specific markets
   * Endpoint: /v3/betfairOdds?marketIds={marketIds}
   * Returns detailed odds data including availableToBack, availableToLay, etc.
   * @param marketIds - Comma-separated market IDs (e.g., "1.250049502,1.250049500")
   */
  async getBetfairOdds(marketIds: string) {
    return this.fetch('/v3/betfairOdds', { marketIds });
  }

  /**
   * Get Betfair results for specific markets
   * Endpoint: /v3/betfairResults?marketIds={marketIds}
   * Returns result data including winner, result, status, type, etc.
   * @param marketIds - Comma-separated market IDs (e.g., "1.249961303")
   */
  async getBetfairResults(marketIds: string) {
    return this.fetch('/v3/betfairResults', { marketIds });
  }

  /**
   * Get bookmaker fancy for a specific event
   * Endpoint: /v3/bookmakerFancy?eventId={eventId}
   * Returns bookmaker fancy data with markets, sections, odds, etc.
   * Data is sorted in the following order:
   * 1. match_odds (MATCH_ODDS)
   * 2. bookmakerfancy (Bookmaker, Bookmaker 2)
   * 3. tie match (Tied Match, TIED_MATCH)
   * 4. normal fancy (all other fancy types)
   * @param eventId - Event ID (e.g., "34917574")
   */
  async getBookmakerFancy(eventId: string | number) {
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
    if (response && response.data && Array.isArray(response.data)) {
      response.data.sort((a, b) => {
        // Helper function to get sort priority
        const getPriority = (item: { mname: string; gtype: string }): number => {
          const mname = item.mname?.toUpperCase() || '';
          const gtype = item.gtype?.toLowerCase() || '';

          // 1. match_odds (MATCH_ODDS)
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
      // - "MATCH_ODDS"
      // - "Bookmaker"
      // - "TIED_MATCH"
      response.data = response.data.filter((market) => {
        const mname = market.mname?.toUpperCase() || '';
        const originalMname = market.mname || '';

        // 1. MATCH_ODDS (case-insensitive)
        if (mname === 'MATCH_ODDS') {
          return true;
        }

        // 2. Bookmaker (exact match, case-sensitive)
        if (originalMname === 'Bookmaker') {
          return true;
        }

        // 3. TIED_MATCH (case-insensitive)
        if (mname === 'TIED_MATCH') {
          return true;
        }

        // 4. Normal (exact match, case-sensitive)
        if (originalMname === 'Normal') {
          return true;
        }

        // Exclude all other markets
        return false;
      });

      // Add isSuspended field to each market
      response.data.forEach((market) => {
        market.isSuspended = this.isMarketSuspended(market);
      });
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

  /**
   * Get fancy bet results for a specific event
   * Endpoint: /v3/fancyResult?eventId={eventId}
   * Returns fancy bet results with odds, runners, etc.
   * @param eventId - Event ID (e.g., "34917574")
   */
  async getFancyResult(eventId: string | number) {
    return this.fetch('/v3/fancyResult', { eventId });
  }

  /**
   * Place bet via vendor API
   * Endpoint: /v3/placeBet (POST)
   * @param betData - Bet placement data
   */
  private async fetchPost<T>(path: string, body: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    try {
      const { data } = await firstValueFrom(
        this.http.post<T>(url, body, {
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      );
      return data;
    } catch (error) {
      this.logger.error(`Error posting to ${url}:`, error instanceof Error ? error.message : String(error));
      
      if (error instanceof AxiosError) {
        const status = error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR;
        const message = error.response?.data?.message || error.message || 'Failed to post data to vendor API';
        
        throw new HttpException(
          {
            statusCode: status,
            message,
            error: 'Vendor API Error',
            details: error.response?.data || undefined,
          },
          status,
        );
      }
      
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

  /**
   * Place bet
   * Endpoint: /v3/placeBet
   * @param betData - Bet placement data
   */
  async placeBet(betData: {
    marketId: string;
    selectionId: number;
    side: 'BACK' | 'LAY';
    size: number;
    price: number;
    eventId?: string;
    [key: string]: any;
  }) {
    return this.fetchPost('/v3/placeBet', betData);
  }
}

