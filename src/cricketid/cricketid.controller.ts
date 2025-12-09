import { Body, Controller, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { CricketIdService } from './cricketid.service';
import { CricketIdWebhookDto } from './dto/webhook.dto';
import { CricketIdWebhookService } from './cricketid.webhook';

@Controller('cricketid')
export class CricketIdController {
  private readonly logger = new Logger(CricketIdController.name);

  constructor(
    private readonly cricketIdService: CricketIdService,
    private readonly webhookService: CricketIdWebhookService,
  ) {}

  @Get('sports')
  getSports() {
    return this.cricketIdService.getSports();
  }

  @Get('matches/all')
  getAllMatches() {
    return this.cricketIdService.getAllMatches();
  }

  @Get('match/detail')
  getSingleMatchDetail(
    @Query('sid') sid: number,
    @Query('gmid') gmid: number,
  ) {
    return this.cricketIdService.getSingleMatchDetail(sid, gmid);
  }

  @Get('match/private')
  getPrivateData(
    @Query('sid') sid: number,
    @Query('gmid') gmid: number,
  ) {
    return this.cricketIdService.getPrivateData(sid, gmid);
  }

  @Get('match')
  getMatch(@Query('match') matchId?: string) {
    return this.cricketIdService.fetchMatch(matchId);
  }

  @Get('match/:matchId')
  getMatchById(@Param('matchId') matchId: string) {
    return this.cricketIdService.fetchMatch(matchId);
  }

  @Get('matches/details/:sid')
  getMatchDetails(@Param('sid') sid: number) {
    return this.cricketIdService.getMatchDetailsBySid(sid);
  }


  @Get('matches/:matchId/fancy')
  getMatchFancy(@Param('matchId') matchId: string) {
    return this.cricketIdService.getMatchFancy(matchId);
  }

  @Get('matches/:matchId/session')
  getMatchSession(@Param('matchId') matchId: string) {
    return this.cricketIdService.getMatchSession(matchId);
  }

  @Get('matches/:matchId/score')
  getMatchScore(@Param('matchId') matchId: string) {
    return this.cricketIdService.getMatchScore(matchId);
  }

  @Post('webhook')
  async handleWebhook(@Body() payload: CricketIdWebhookDto) {
    this.logger.debug(`Webhook payload received: ${JSON.stringify(payload)}`);
    await this.webhookService.handleWebhook(payload);
    return { success: true };
  }
}

