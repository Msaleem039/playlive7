import { Controller, Get, Param, Query } from '@nestjs/common';
import { AggregatorService } from './aggregator.service';

@Controller('cricketid/aggregator')
export class AggregatorController {
  constructor(private service: AggregatorService) {}

  // GET /cricketid/aggregator/cricket (backward compatible, defaults to sportId=4)
  @Get('cricket')
  async getCricketMatches() {
    return this.service.getAllCricketMatches('4');
  }

  // GET /cricketid/aggregator/matches?sportId=4 (generic endpoint for all sports)
  // ✅ MULTI-SPORT: Supports Soccer (1), Tennis (2), Cricket (4)
  @Get('matches')
  async getMatches(@Query('sportId') sportId?: string | number) {
    // Default to 4 (Cricket) for backward compatibility
    const normalizedSportId = sportId ? String(sportId) : '4';
    return this.service.getAllCricketMatches(normalizedSportId);
  }

  // GET /cricketid/aggregator/match/35044997
  @Get('match/:eventId')
  async getMatch(@Param('eventId') eventId: string) {
    return this.service.getMatchDetail(eventId);
  }

  // GET /cricketid/aggregator/odds?eventId=34917574&marketIds=1.250049502,1.250049500
  @Get('odds')
  async getOddsFancy(
    @Query('eventId') eventId: string,
    @Query('marketIds') marketIds: string,
  ) {
    if (!eventId || !marketIds) {
      return {
        success: false,
        message: 'eventId and marketIds are required',
      };
    }
    try {
      return await this.service.getOddsAndFancy(eventId, marketIds);
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch odds and fancy',
        error: 'Internal Server Error',
      };
    }
  }
}

