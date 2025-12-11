import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class CricketIdService {
  private readonly baseUrl = 'https://vendorapi.tresting.com';

  constructor(private readonly http: HttpService) {}

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;

    const { data } = await firstValueFrom(
      this.http.get<T>(url, {
        params,
      }),
    );
    return data;
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
   * Endpoint: /v3/matchList?sportId=4&competitionId={competitionId}
   * @param competitionId - Competition ID from the series list (e.g., "9992899")
   */
  async getMatchDetails(competitionId: string | number) {
    return this.fetch('/v3/matchList', { 
      sportId: 4, // Cricket sport ID
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
   * Returns result data including winner, result, status, etc.
   * @param marketIds - Comma-separated market IDs (e.g., "1.249961303")
   */
  async getBetfairResults(marketIds: string) {
    return this.fetch('/v3/betfairResults', { marketIds });
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

    const { data } = await firstValueFrom(
      this.http.post<T>(url, body, {
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    return data;
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

