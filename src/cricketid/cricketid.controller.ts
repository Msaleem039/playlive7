import { Body, Controller, Get, Logger, Param, Post, Query, HttpException, HttpStatus } from '@nestjs/common';
import { CricketIdService } from './cricketid.service';

@Controller('cricketid')
export class CricketIdController {
  private readonly logger = new Logger(CricketIdController.name);

  constructor(
    private readonly cricketIdService: CricketIdService,
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
   * GET /cricketid/matches?sportId=4&competitionId={competitionId}
   * Example: GET /cricketid/matches?sportId=4&competitionId=9992899
   * @param competitionId - Competition ID from the series list (e.g., "9992899")
   * @param sportId - Sport ID (default: 4 for cricket)
   */
  @Get('matches')
  getMatchDetails(
    @Query('competitionId') competitionId: string | number,
    @Query('sportId') sportId?: number,
  ) {
    return this.cricketIdService.getMatchDetails(
      competitionId,
      sportId ? Number(sportId) : 4,
    );
  }

  /**
   * Get market list (odds/markets) for a specific event/match
   * GET /cricketid/markets?eventId={eventId}
   * Example: GET /cricketid/markets?eventId=34917574
   * Returns markets with runners, selectionId, marketName, etc.
   * @param eventId - Event ID from the match list (e.g., "34917574")
   */
  @Get('markets')
  async getMarketList(@Query('eventId') eventId: string | number) {
    if (!eventId) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'eventId query parameter is required',
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.cricketIdService.getMarketList(eventId);
    } catch (error) {
      // Only log non-400 errors (400 errors are expected for invalid/expired eventIds)
      if (error instanceof HttpException && error.getStatus() !== 400) {
        this.logger.error(`Error getting market list for eventId ${eventId}:`, error);
      }
      throw error;
    }
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
   * Get bookmaker fancy for a specific event
   * GET /cricketid/bookmaker-fancy?eventId=34917574
   * Returns bookmaker fancy data with markets, sections, odds, etc.
   * @param eventId - Event ID (e.g., "34917574")
   */
  @Get('bookmaker-fancy')
  async getBookmakerFancy(@Query('eventId') eventId: string | number) {
    if (!eventId) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'eventId query parameter is required',
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.cricketIdService.getBookmakerFancy(eventId);
    } catch (error) {
      // Only log non-400 errors (400 errors are expected for invalid/expired eventIds)
      if (error instanceof HttpException && error.getStatus() !== 400) {
        this.logger.error(`Error getting bookmaker fancy for eventId ${eventId}:`, error);
      }
      throw error;
    }
  }

}

