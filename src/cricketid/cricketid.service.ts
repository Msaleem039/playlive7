import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import {
  CricketIdApiResponse,
  CricketIdFancy,
  CricketIdMatch,
  CricketIdOdds,
  CricketIdScore,
  CricketIdSport,
  AllMatchesResponse,
} from './cricketid.interface';

@Injectable()
export class CricketIdService {
  private readonly baseUrl = 'https://gold3patti.biz:4000';

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

  getSports(): Promise<CricketIdApiResponse<CricketIdSport[]>> {
    return this.fetch('/allSportid');
  }

  getMatchDetailsBySid(sid: number): Promise<CricketIdApiResponse<CricketIdMatch>> {
    return this.fetch('/esid', { sid });
  }
  getSingleMatchDetail(sid: number, gmid: number) {
    return this.fetch('/getDetailsData', { sid, gmid });
  }

  getAllMatches(): Promise<AllMatchesResponse> {
    return this.fetch('/cricket/allmatches');
  }

  /**
   * Get the first available match ID from all matches
   * @returns The first match event ID or null if no matches found
   */
  private async getFirstMatchId(): Promise<string | null> {
    try {
      const response = await this.getAllMatches();
      if (
        response?.data?.result &&
        Array.isArray(response.data.result) &&
        response.data.result.length > 0
      ) {
        const firstMatch = response.data.result[0];
        return firstMatch?.event?.id || null;
      }
      return null;
    } catch (error) {
      console.error('Error fetching first match ID:', error);
      return null;
    }
  }

  async fetchMatch(matchId?: string | number) {
    // If no matchId provided, dynamically fetch the first match ID
    if (!matchId) {
      const dynamicMatchId = await this.getFirstMatchId();
      if (!dynamicMatchId) {
        throw new Error('No matches available and no match ID provided');
      }
      matchId = dynamicMatchId;
    }
    return this.fetch('/cricket/fetchmatch', { match: matchId });
  }
  
  getPrivateData(sid: number, gmid: number) {
    return this.fetch('/getPriveteData', { sid, gmid });
  }
  
  getMatchFancy(matchId: string): Promise<CricketIdApiResponse<CricketIdFancy[]>> {
    return this.fetch('/matchFancy', { match_id: matchId });
  }

  getMatchSession(matchId: string): Promise<CricketIdApiResponse<CricketIdOdds[]>> {
    return this.fetch('/session', { match_id: matchId });
  }

  getMatchScore(matchId: string): Promise<CricketIdApiResponse<CricketIdScore>> {
    return this.fetch('/score', { match_id: matchId });
  }
}

