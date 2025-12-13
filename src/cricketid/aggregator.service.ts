import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);
  private readonly baseUrl = 'https://72.61.140.55';
  private cache = new Map<string, { data: any; expiresAt: number }>();

  constructor(private readonly http: HttpService) {
    // Clean up expired cache entries every 5 minutes
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
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
          timeout: 8000,
        }),
      );
      return data;
    } catch (error) {
      this.logger.error(`Error fetching ${url}:`, error);
      throw error;
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
      return Array.isArray(response) ? response : [];
    } catch (error) {
      this.logger.error(`Error fetching matches for competitionId ${competitionId}:`, error);
      return []; // return empty array on error to continue
    }
  }

  /**
   * Fetch all cricket matches and classify Live / Upcoming
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

        return {
          total: allMatches.length,
          // all: allMatches,
          live: allMatches.filter(m => new Date(m?.event?.openDate) <= new Date()),
          upcoming: allMatches.filter(m => new Date(m?.event?.openDate) > new Date()),
        };
      },
    );
  }

  /**
   * Match detail (markets)
   * Endpoint: /cricketid/markets?eventId={eventId}
   * @param eventId - Event ID
   */
  async getMatchDetail(eventId: string) {
    try {
      const response = await this.fetch('/cricketid/markets', { eventId });
      return response;
    } catch (error) {
      this.logger.error(`Error fetching match detail for eventId ${eventId}:`, error);
      throw error;
    }
  }

  /**
   * Get bookmaker fancy for a specific event
   * Endpoint: /v3/bookmakerFancy?eventId={eventId}
   * @param eventId - Event ID
   */
  private async getBookmakerFancy(eventId: string) {
    return this.fetch('/v3/bookmakerFancy', { eventId });
  }

  /**
   * Get Betfair odds for specific markets
   * Endpoint: /v3/betfairOdds?marketIds={marketIds}
   * @param marketIds - Comma-separated market IDs
   */
  private async getMatchOdds(marketIds: string) {
    return this.fetch('/v3/betfairOdds', { marketIds });
  }

  /**
   * Get combined odds (bookmaker fancy + match odds)
   * Fetches both bookmaker fancy and Betfair odds in parallel and returns merged result
   * @param eventId - Event ID (e.g., "34917574")
   * @param marketIds - Comma-separated market IDs (e.g., "1.250049502,1.250049500")
   */
  async getCombinedOdds(eventId: string, marketIds: string) {
    try {
      const [bookmakerFancy, matchOdds] = await Promise.all([
        this.getBookmakerFancy(eventId),
        this.getMatchOdds(marketIds),
      ]);

      return {
        eventId,
        marketIds: marketIds.split(','),
        bookmakerFancy,
        matchOdds,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to fetch combined odds', error);
      throw error;
    }
  }
}

