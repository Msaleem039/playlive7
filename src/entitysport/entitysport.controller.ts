import { Controller, Get, Param, Query } from '@nestjs/common';
import { EntitySportService } from './entitysport.service';

@Controller('entitysport')
export class EntitySportController {
  constructor(private readonly entitySportService: EntitySportService) {}

  @Get('seasons')
  getSeasons(@Query('sid') sid?: number) {
    return this.entitySportService.getSeasons(sid);
  }

  @Get('competitions')
  getCompetitions(@Query('cid') cid?: number) {
    return this.entitySportService.getCompetitions(cid);
  }

  @Get('matches')
  getMatches(@Query('mid') mid?: number) {
    return this.entitySportService.getMatches(mid);
  }

  @Get('matches/:mid/live')
  getLiveMatch(@Param('mid') mid: number) {
    return this.entitySportService.getLiveMatch(mid);
  }

  @Get('matches/:mid/scorecard')
  getScorecard(@Param('mid') mid: number) {
    return this.entitySportService.getScorecard(mid);
  }

  @Get('matches/:mid/commentary/:inning')
  getCommentary(@Param('mid') mid: number, @Param('inning') inning: number) {
    return this.entitySportService.getCommentary(mid, inning);
  }
}
