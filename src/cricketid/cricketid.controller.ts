import { Body, Controller, Get, Logger, Param, Post, Query, HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
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
   * Get all leagues/competitions for a sport (vendor: v3/seriesList).
   * GET /cricketid/series?sportId=2
   * Returns array of { competition: { id, name }, competitionRegion, marketCount }.
   * ✅ MULTI-SPORT: Soccer (1), Tennis (2), Cricket (4). Example Tennis: sportId=2
   */
  @Get('series')
  getSeriesList(@Query() query: Record<string, string | number | undefined>) {
    const rawSportId = query?.sportId ?? query?.sportid;
    const normalizedSportId =
      rawSportId !== undefined && rawSportId !== null ? Number(rawSportId) : 4;
    return this.cricketIdService.getSeriesList(normalizedSportId);
  }

  @Get('series/:sportId')
  getSeriesListByParam(@Param('sportId') sportId: string) {
    return this.cricketIdService.getSeriesList(sportId);
  }

  /**
   * Get match detail by marketId or eventId.
   * GET /cricketid/match-detail?marketId=1.255542873
   * GET /cricketid/match-detail?marketId=35414637  (eventId passed in marketId field)
   * GET /cricketid/match-detail?eventId=35402112
   */
  @Get('match-detail')
  async getMatchDetailByEventId(
    @Query() query: Record<string, string | number | undefined>,
  ) {
    const marketId = query?.marketId ?? query?.marketid;
    const eventId = query?.eventId ?? query?.eventid;
    if (marketId) {
      return this.cricketIdService.getMatchDetailByMarketId(String(marketId));
    }
    if (!eventId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'marketId or eventId query parameter is required',
        error: 'Bad Request',
      });
    }
    return this.cricketIdService.getMatchDetails(String(eventId));
  }

  // Backward-compatible alias (some clients call /cricketid/matches?eventId=...)
  @Get('matches')
  async getMatchDetailAlias(@Query() query: Record<string, string | number | undefined>) {
    return this.getMatchDetailByEventId(query);
  }

  /**
   * Get market list (odds/markets) for a specific event/match
   * GET /cricketid/markets?eventId={eventId}&sportId=1
   * Example: GET /cricketid/markets?eventId=34917574
   * Returns markets with runners, selectionId, marketName, etc.
   * @param eventId - Event ID from the match list (e.g., "34917574")
   */
  @Get('markets')
  async getMarketList(@Query() query: Record<string, string | number | undefined>) {
    const eventId = query?.eventId ?? query?.eventid;
    const sportId = query?.sportId ?? query?.sportid;
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
      return await this.cricketIdService.getMarketList(eventId, sportId);
    } catch (error) {
      // Only log non-400 errors (400 errors are expected for invalid/expired eventIds)
      if (error instanceof HttpException && error.getStatus() !== 400) {
        this.logger.error(`Error getting market list for eventId ${eventId}:`, error);
      }
      throw error;
    }
  }

  /**
   * Get Betfair odds for specific markets.
   * Supports either:
   * - GET /cricketid/odds?marketIds=1.250049502,1.250049500
   * - GET /cricketid/odds?eventId=34917574
   * - GET /cricketid/odds?eventId=…&sportId=1   (1=soccer, 2=tennis, 4=cricket; omit = try 4→1→2)
   *
   * When eventId is provided, Match Odds marketId(s) are resolved automatically.
   */
  @Get('odds')
  async getBetfairOdds(@Query() query: Record<string, string | number | undefined>) {
    const marketIds = query?.marketIds;
    if (marketIds) {
      return this.cricketIdService.getBetfairOdds(String(marketIds));
    }

    const eventId = query?.eventId ?? query?.eventid;
    const sportId = query?.sportId ?? query?.sportid;
    if (!eventId) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'marketIds or eventId query parameter is required',
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const isMatchOddsRow = (m: any) => {
      const marketName = String(m?.marketName ?? m?.mname ?? '').toLowerCase().trim();
      return (
        marketName === 'match odds' ||
        marketName === 'match_odds' ||
        (marketName.includes('match') && marketName.includes('odd'))
      );
    };

    const extractMatchOddsIds = (items: any) =>
      Array.from(
        new Set(
          (Array.isArray(items) ? items : [])
            .filter(isMatchOddsRow)
            .map((m: any) => String(m?.marketId ?? '').trim())
            .filter(Boolean),
        ),
      );

    // 1) market-list (fair-demo primary + legacy fallback inside service)
    let matchOddsMarketIds: string[] = [];
    try {
      const markets = await this.cricketIdService.getMarketList(String(eventId), sportId);
      matchOddsMarketIds = extractMatchOddsIds(markets);
    } catch {
      // continue to fallbacks
    }

    // 2) Resolve MarketId from sport feed(s), optional horsedata rows for exact name match
    if (!matchOddsMarketIds.length) {
      try {
        const mid = await this.cricketIdService.resolveMarketIdFromEvent(String(eventId), sportId);
        if (mid) {
          try {
            const detail = await this.cricketIdService.getMatchDetailByMarketId(mid);
            const fromDetail = extractMatchOddsIds(detail);
            matchOddsMarketIds = fromDetail.length ? fromDetail : [mid];
          } catch {
            matchOddsMarketIds = [mid];
          }
        }
      } catch {
        // best effort
      }
    }

    if (!matchOddsMarketIds.length) {
      throw new HttpException(
        {
          statusCode: HttpStatus.BAD_REQUEST,
          message: `No Match Odds market found for eventId ${eventId} (market-list/feed/horsedata lookups failed)`,
          error: 'Bad Request',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.cricketIdService.getBetfairOdds(matchOddsMarketIds.join(','));
  }


  /**
   * Get bookmaker fancy for a specific event
   * GET /cricketid/bookmaker-fancy?eventId=34917574
   * Returns bookmaker fancy data with markets, sections, odds, etc.
   * @param eventId - Event ID (e.g., "34917574")
   */
  @Get('bookmaker-fancy')
  async getBookmakerFancy(@Query() query: Record<string, string | number | undefined>) {
    const eventId = query?.eventId ?? query?.eventid;
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

  /**
   * Fancy (Diamond) vendor API
   * GET /cricketid/fancy?eventId=35401953
   */
  @Get('fancy')
  async getDiamondFancy(@Query() query: Record<string, string | number | undefined>) {
    const eventId = query?.eventId ?? query?.eventid;
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
    return this.cricketIdService.getDiamondFancy(eventId);
  }

  /**
   * Get top matches for Soccer or Tennis only.
   * GET /cricketid/top-matches?sportId=1&limit=5
   * - sportId: 1 (Soccer) or 2 (Tennis) - required
   * - limit: max number of matches to return (default: 10, min: 1)
   *
   * Cricket (4) is not handled here; passing 4 will result in BadRequestException
   * from the underlying service validation.
   */
  @Get('top-matches')
  async getTopMatchesBySport(
    @Query('sportId') sportId?: string | number,
    @Query('limit') limit?: string | number,
  ) {
    if (sportId === undefined || sportId === null) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'sportId query parameter is required and must be 1 (Soccer) or 2 (Tennis)',
        error: 'Bad Request',
      });
    }

    const normalizedSportId = Number(sportId);
    const normalizedLimit = limit !== undefined && limit !== null ? Number(limit) : 10;

    return this.cricketIdService.getTopMatchesBySport(normalizedSportId, normalizedLimit);
  }

  /**
   * Direct vendor sport-wise matches (no aggregation via series/competition loops).
   * GET /cricketid/events-by-sport?sportId=4
   * GET /cricketid/events-by-sport/4
   */
  @Get('events-by-sport')
  async getEventsBySport(@Query('sportId') sportId?: string | number) {
    if (sportId === undefined || sportId === null || String(sportId).trim() === '') {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'sportId query parameter is required',
        error: 'Bad Request',
      });
    }
    return this.cricketIdService.getEventsBySportId(sportId);
  }

  @Get('events-by-sport/:sportId')
  async getEventsBySportParam(@Param('sportId') sportId: string) {
    return this.cricketIdService.getEventsBySportId(sportId);
  }

  /**
   * Get markets for a specific match/event (reuses existing market caching).
   * GET /cricketid/match-markets?eventId={eventId}
   */
  @Get('match-markets')
  async getMatchMarkets(@Query('eventId') eventId: string) {
    if (!eventId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'eventId query parameter is required',
        error: 'Bad Request',
      });
    }

    return this.cricketIdService.getMatchMarkets(eventId);
  }

  /**
   * Get live score for a specific event from cache.tresting.com
   * GET /cricketid/score?eventId={eventId}
   *
   * Thin wrapper around the vendor cache API:
   * https://cache.tresting.com/v2/api/getScoreByEventIdNew?eventId={eventId}
   */
  @Get('score')
  async getScoreByEventId(@Query('eventId') eventId: string | number) {
    if (!eventId) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'eventId query parameter is required',
        error: 'Bad Request',
      });
    }

    return this.cricketIdService.getScoreByEventId(eventId);
  }

}

