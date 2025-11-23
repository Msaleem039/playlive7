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
} from './cricketid.interface';

@Injectable()
export class CricketIdService {
  private readonly baseUrl = 'https://api.cricketid.xyz';
  private readonly apiKey = 'dijbfuwd719e12rqhfbjdqdnkqnd11';

  constructor(private readonly http: HttpService) {}

  private async fetch<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
    const requestParams = {
      key: this.apiKey,
      ...params,
    };

    const { data } = await firstValueFrom(
      this.http.get<T>(url, {
        params: requestParams,
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

