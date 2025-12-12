import { Controller, Get, Param } from '@nestjs/common';
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
}

