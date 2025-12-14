import { Controller, Get, Param, Query } from '@nestjs/common';
import { AggregatorService } from './aggregator.service';

@Controller('cricketid/aggregator')
export class AggregatorController {
  constructor(private service: AggregatorService) {}

  // GET /cricketid/aggregator/cricket
  @Get('cricket')
  async getCricketMatches() {
    return this.service.getAllCricketMatches();
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
    // Method never throws, always returns a response
    return await this.service.getOddsAndFancy(eventId, marketIds);
  }
}

