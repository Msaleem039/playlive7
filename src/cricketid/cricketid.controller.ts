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

  /**
   * Get all sports/events
   * GET /cricketid/sports
   */
  @Get('sports')
  getAllSports() {
    return this.cricketIdService.getAllSports();
  }

  /**
   * Get all competitions/series for a specific sport
   * GET /cricketid/series?sportId=4
   * Returns list of competitions with competition.id, competition.name, etc.
   * @param sportId - Sport ID (4 for cricket)
   */
  @Get('series')
  getSeriesList(@Query('sportId') sportId: number) {
    return this.cricketIdService.getSeriesList(sportId);
  }

  /**
   * Get match details by competition ID
   * GET /cricketid/matches?competitionId={competitionId}
   * Example: GET /cricketid/matches?competitionId=9992899
   * @param competitionId - Competition ID from the series list (e.g., "9992899")
   */
  @Get('matches')
  getMatchDetails(@Query('competitionId') competitionId: string | number) {
    return this.cricketIdService.getMatchDetails(competitionId);
  }

  /**
   * Get market list (odds/markets) for a specific event/match
   * GET /cricketid/markets?eventId={eventId}
   * Example: GET /cricketid/markets?eventId=34917574
   * Returns markets with runners, selectionId, marketName, etc.
   * @param eventId - Event ID from the match list (e.g., "34917574")
   */
  @Get('markets')
  getMarketList(@Query('eventId') eventId: string | number) {
    return this.cricketIdService.getMarketList(eventId);
  }

  /**
   * Get Betfair odds for specific markets
   * GET /cricketid/odds?marketIds=1.250049502,1.250049500
   * Returns detailed odds data including availableToBack, availableToLay, tradedVolume, etc.
   * @param marketIds - Comma-separated market IDs (e.g., "1.250049502,1.250049500")
   */
  @Get('odds')
  getBetfairOdds(@Query('marketIds') marketIds: string) {
    return this.cricketIdService.getBetfairOdds(marketIds);
  }

  /**
   * Get Betfair results for specific markets
   * GET /cricketid/results?marketIds=1.249961303
   * Returns result data including winner, result, status, type, etc.
   * @param marketIds - Comma-separated market IDs (e.g., "1.249961303")
   */
  @Get('results')
  getBetfairResults(@Query('marketIds') marketIds: string) {
    return this.cricketIdService.getBetfairResults(marketIds);
  }

  /**
   * Get fancy bet results for a specific event
   * GET /cricketid/fancy-result?eventId=34917574
   * Returns fancy bet results with odds, runners, etc.
   * @param eventId - Event ID (e.g., "34917574")
   */
  @Get('fancy-result')
  getFancyResult(@Query('eventId') eventId: string | number) {
    return this.cricketIdService.getFancyResult(eventId);
  }

  /**
   * Place bet via vendor API
   * POST /cricketid/place-bet
   * Body: { marketId, selectionId, side, size, price, eventId, ... }
   */
  @Post('place-bet')
  async placeBet(@Body() betData: {
    marketId: string;
    selectionId: number;
    side: 'BACK' | 'LAY';
    size: number;
    price: number;
    eventId?: string;
    [key: string]: any;
  }) {
    return this.cricketIdService.placeBet(betData);
  }

  @Post('webhook')
  async handleWebhook(@Body() payload: CricketIdWebhookDto) {
    this.logger.debug(`Webhook payload received: ${JSON.stringify(payload)}`);
    await this.webhookService.handleWebhook(payload);
    return { success: true };
  }
}

