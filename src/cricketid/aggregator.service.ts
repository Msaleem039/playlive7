import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import * as https from 'https';

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);
  private readonly baseUrl = 'https://72.61.140.55';

  constructor(private readonly http: HttpService) {}

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `https://72.61.140.55${normalizedPath}`;

    try {
      const { data } = await firstValueFrom(
        this.http.get<T>(url, {
          params,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }), // SSL bypass for IP
          headers: { host: 'vendorapi.tresting.com' },               // must match the API host
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
      const response = await this.fetch<{ data?: any[] }>('/cricketid/series', { sportId });
      return response.data || [];
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
      const response = await this.fetch('/cricketid/matches', { competitionId });
      return response || [];
    } catch (error) {
      this.logger.error(`Error fetching matches for competitionId ${competitionId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch all cricket matches and classify Live / Upcoming
   * @param sportId - Sport ID (default: '4' for cricket)
   */
  async getAllCricketMatches(sportId: string = '4') {
    try {
      const competitions = await this.getCompetitions(sportId);

      const allMatches: any[] = [];

      for (const competition of competitions) {
        const compId = competition?.competition?.id;
        if (!compId) {
          this.logger.warn(`Skipping competition without ID: ${JSON.stringify(competition)}`);
          continue;
        }

        try {
          const matchList = await this.getMatchesByCompetition(compId);
          if (Array.isArray(matchList)) {
            allMatches.push(...matchList);
          } else if (matchList && typeof matchList === 'object') {
            // Handle case where response might be wrapped
            const matches = (matchList as any).data || (matchList as any).result || matchList;
            if (Array.isArray(matches)) {
              allMatches.push(...matches);
            } else {
              allMatches.push(matchList);
            }
          }
        } catch (error) {
          this.logger.error(`Error fetching matches for competition ${compId}:`, error);
          // Continue with other competitions even if one fails
        }
      }

      // Classify matches
      const now = new Date();
      const live: any[] = [];
      const upcoming: any[] = [];

      for (const match of allMatches) {
        const dateStr = match?.event?.openDate;
        if (!dateStr) {
          upcoming.push(match);
          continue;
        }

        try {
          const matchTime = new Date(dateStr);

          if (matchTime <= now) {
            live.push(match);
          } else {
            upcoming.push(match);
          }
        } catch (error) {
          this.logger.warn(`Invalid date format for match: ${dateStr}`, error);
          upcoming.push(match);
        }
      }

      return {
        total: allMatches.length,
        live,
        upcoming,
        all: allMatches,
      };
    } catch (error) {
      this.logger.error('Error fetching all cricket matches:', error);
      throw error;
    }
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
}

