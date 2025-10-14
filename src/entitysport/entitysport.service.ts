import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class EntitySportService {
  private readonly BASE_URL = 'https://rest.entitysport.com/v2/';
  private readonly API_TOKEN = 'ec471071441bb2ac538a0ff901abd249';

  constructor(private readonly httpService: HttpService) {}

  private async makeRequest(endpoint: string, params: Record<string, any> = {}) {
    try {
      const query = { ...params, token: this.API_TOKEN };
      const response = await firstValueFrom(
        this.httpService.get(`${this.BASE_URL}${endpoint}`, { params: query }),
      );
      return response.data;
    } catch (error) {
      throw new HttpException(
        {
          statusCode: error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
          message: error.response?.data?.error || 'EntitySport API Error',
        },
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ✅ Update Token (Optional)
  async updateToken(accessKey: string, secretKey: string) {
    return this.makeRequest('auth', { access_key: accessKey, secret_key: secretKey });
  }

  // ✅ Get Seasons
  async getSeasons(sid?: number, args?: Record<string, any>) {
    const endpoint = sid ? `seasons/${sid}/competitions` : 'seasons';
    return this.makeRequest(endpoint, args);
  }

  // ✅ Get Competitions
  async getCompetitions(cid?: number, args?: Record<string, any>) {
    const endpoint = cid ? `competitions/${cid}` : 'competitions';
    return this.makeRequest(endpoint, args);
  }

  // ✅ Get Matches
  async getMatches(mid?: number, args?: Record<string, any>) {
    const endpoint = mid ? `matches/${mid}/info` : 'matches';
    return this.makeRequest(endpoint, args);
  }

  // ✅ Get Live Matches
  async getLiveMatch(mid: number, args?: Record<string, any>) {
    return this.makeRequest(`matches/${mid}/live`, args);
  }

  // ✅ Get Scorecard
  async getScorecard(mid: number, args?: Record<string, any>) {
    return this.makeRequest(`matches/${mid}/scorecard`, args);
  }

  // ✅ Get Commentary
  async getCommentary(mid: number, inning: number, args?: Record<string, any>) {
    return this.makeRequest(`matches/${mid}/innings/${inning}/commentary`, args);
  }
}
