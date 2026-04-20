import {
  Controller,
  Get,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Query,
} from '@nestjs/common';
import { PositionService } from './position.service';
import { PrismaService } from '../prisma/prisma.service';
import { AggregatorService } from '../cricketid/aggregator.service';
import { CricketIdService } from '../cricketid/cricketid.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BetStatus } from '@prisma/client';
import type { User } from '@prisma/client';
import { RedisService } from '../common/redis/redis.service';
import { 
  calculateAllPositions,
  MatchOddsPosition,
  BookmakerPosition,
} from './position.service';

@Controller('positions')
@UseGuards(JwtAuthGuard)
export class PositionsController {
  private readonly logger = new Logger(PositionsController.name);

  constructor(
    private readonly positionService: PositionService,
    private readonly prisma: PrismaService,
    private readonly aggregatorService: AggregatorService,
    private readonly cricketIdService: CricketIdService,
    private readonly redisService: RedisService, // ✅ PERFORMANCE: Redis for position snapshots
  ) {}

  private isTiedMatchMarketName(marketName: string | null | undefined): boolean {
    const normalized = String(marketName || '').trim().toLowerCase();
    if (!normalized) return false;
    return (
      normalized.includes('tied_match') ||
      normalized.includes('tied match') ||
      normalized.includes('tied-match')
    );
  }

  /**
   * Match a catalog market node from getMatchDetail(eventId) to open bets on bet.marketId.
   *
   * Listing/detail feeds often resolve a different primary marketId than the exchange id stored on bets
   * (e.g. 1.256844687 on the bet vs another id in horsedata). Exact id match then fails even though runners exist.
   *
   * We use pending bet selectionIds only to choose which catalog node is the same market; runner ids in the
   * response are still the full API list for that node — never built from bets alone.
   */
  private resolveCatalogMarketNode(
    markets: any[],
    betMarketId: string,
    marketBets: Array<{ selectionId: number | null | undefined }>,
    kind: 'matchOdds' | 'bookmaker',
  ): any | null {
    if (!Array.isArray(markets) || markets.length === 0) {
      return null;
    }

    const byExact = markets.find((m: any) => String(m?.marketId) === String(betMarketId));
    if (byExact && Array.isArray(byExact.runners) && byExact.runners.length > 0) {
      return byExact;
    }

    if (kind === 'matchOdds') {
      const isMoLikeName = (marketName: string) => {
        const n = String(marketName || '').trim().toLowerCase();
        if (!n) return false;
        if (
          n.includes('including tie') ||
          n.includes('tied match') ||
          n.includes('tied_match') ||
          n.includes('completed match')
        ) {
          return false;
        }
        return n === 'match odds' || n.includes('match odds');
      };
      const byName = markets.find((m: any) => isMoLikeName(m?.marketName || ''));
      if (byName && Array.isArray(byName.runners) && byName.runners.length > 0) {
        return byName;
      }
    }

    const betSelections = new Set(
      marketBets
        .map((b) => b.selectionId)
        .filter((id): id is number => id !== null && id !== undefined)
        .map((id) => String(id)),
    );
    if (betSelections.size === 0) {
      return null;
    }

    const runnerIdSet = (m: any): Set<string> =>
      new Set(
        (Array.isArray(m?.runners) ? m.runners : [])
          .map((r: any) => (r?.selectionId != null && r?.selectionId !== undefined ? String(r.selectionId) : null))
          .filter((id): id is string => id !== null),
      );

    const containsAll = markets.filter((m) => {
      const rs = runnerIdSet(m);
      if (rs.size === 0) return false;
      return [...betSelections].every((id) => rs.has(id));
    });
    const overlap = markets.filter((m) => {
      const rs = runnerIdSet(m);
      return [...betSelections].some((id) => rs.has(id));
    });
    const pool = containsAll.length > 0 ? containsAll : overlap;
    if (pool.length === 0) {
      return null;
    }
    pool.sort((a, b) => (b.runners?.length || 0) - (a.runners?.length || 0));
    return pool[0];
  }

  /**
   * ✅ GET /positions?eventId={eventId}
   * 
   * Returns all positions (P/L projections) for the authenticated user across all market types.
   * 
   * Query Parameters:
   * - eventId (optional): Filter positions for a specific event/match
   * 
   * 🚨 CRITICAL RULES:
   * - Position is calculated fresh from ALL open bets (never stored in DB)
   * - Markets are completely isolated (Match Odds, Fancy, Bookmaker)
   * - Position is UI/display only - does not affect wallet or exposure
   * 
   * Response Format:
   * {
   *   "eventId": "32547891",
   *   "matchOdds": {
   *     "7337": 80,      // selectionId -> net P/L (can be negative)
   *     "10301": -200
   *   },
   *   "bookmaker": {
   *     "7337": 120,
   *     "10301": -150
   *   },
   *   "fancy": {
   *     "fancyId_1": {
   *       "YES": 50,
   *       "NO": -100
   *     }
   *   }
   * }
   */
  @Get()
  async getAllPositions(
    @CurrentUser() user: User,
    @Query('eventId') eventId?: string,
  ) {
    try {
      // ✅ Load open bets for this user (filter by eventId if provided)
      const whereClause: any = {
        userId: user.id,
        status: BetStatus.PENDING,
      };
      
      if (eventId) {
        whereClause.eventId = eventId;
      }
      
      const openBets = await this.prisma.bet.findMany({
        where: whereClause,
        select: {
          id: true,
          gtype: true,
          marketId: true,
          marketName: true,
          eventId: true,
          selectionId: true,
          betType: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
          winAmount: true,
          lossAmount: true,
          betName: true,
          status: true,
        },
        orderBy: {
          createdAt: 'desc', // Most recent bets first
        },
      });

      // ✅ DEBUG: Log all bets to verify they're included
      this.logger.debug(
        `Calculating positions for user ${user.id}: Found ${openBets.length} open bets`,
      );
      
      // Log Match Odds bets specifically
      const matchOddsBets = openBets.filter(
        (bet) => (bet.gtype || '').toLowerCase() === 'matchodds' || (bet.gtype || '').toLowerCase() === 'match',
      );
      if (matchOddsBets.length > 0) {
        this.logger.debug(
          `Match Odds bets (${matchOddsBets.length}): ` +
          matchOddsBets.map(
            (bet) => `id=${bet.id}, marketId=${bet.marketId}, selectionId=${bet.selectionId}, betType=${bet.betType}, stake=${bet.betValue ?? bet.amount}`,
          ).join('; '),
        );
      }

      // ✅ CRITICAL: Use selectionIds from bets (these match UI/Match Detail API selectionIds)
      // This ensures Position API returns selectionIds that match what the UI expects
      const marketSelectionsMap = new Map<string, string[]>();
      
      // Group Match Odds bets by eventId and marketId
      const matchOddsBetsByEvent = new Map<string, Map<string, typeof openBets>>();
      for (const bet of openBets) {
        const betGtype = (bet.gtype || '').toLowerCase();
        const isMatchOdds = (betGtype === 'matchodds' || betGtype === 'match') && bet.marketId && bet.eventId;
        
        if (isMatchOdds && bet.marketId && bet.eventId) {
          const eventId = bet.eventId;
          const marketId = bet.marketId;
          
          if (!matchOddsBetsByEvent.has(eventId)) {
            matchOddsBetsByEvent.set(eventId, new Map());
          }
          const marketsMap = matchOddsBetsByEvent.get(eventId)!;
          if (!marketsMap.has(marketId)) {
            marketsMap.set(marketId, []);
          }
          marketsMap.get(marketId)!.push(bet);
        }
      }

      // Group Bookmaker bets by eventId and marketId (for API runner resolution — not used to infer selection ids)
      const bookmakerBetsByEvent = new Map<string, Map<string, typeof openBets>>();
      for (const bet of openBets) {
        const betGtype = (bet.gtype || '').toLowerCase();
        const isBookmaker =
          betGtype === 'bookmaker' ||
          (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
        if (isBookmaker && bet.marketId && bet.eventId) {
          const eventId = bet.eventId;
          const marketId = bet.marketId;
          if (!bookmakerBetsByEvent.has(eventId)) {
            bookmakerBetsByEvent.set(eventId, new Map());
          }
          const bmMap = bookmakerBetsByEvent.get(eventId)!;
          if (!bmMap.has(marketId)) {
            bmMap.set(marketId, []);
          }
          bmMap.get(marketId)!.push(bet);
        }
      }
      
      // ✅ PERFORMANCE: Get ALL runners from getMatchDetail API in parallel (not sequential)
      // ✅ PERFORMANCE: getMatchDetail now reads from Redis cache (fast, <10ms)
      // This ensures we use the correct selectionIds that match the actual bets
      const eventIds = Array.from(
        new Set([...matchOddsBetsByEvent.keys(), ...bookmakerBetsByEvent.keys()]),
      );
      
      // ✅ PERFORMANCE: Fetch all match details in parallel instead of sequentially
      const matchDetailsResults = await Promise.allSettled(
        eventIds.map(async (eventId) => {
          try {
            // ✅ PERFORMANCE: getMatchDetail reads from Redis cache (pre-warmed by cron)
            const marketDetails = await this.aggregatorService.getMatchDetail(eventId);
            return { eventId, marketDetails: Array.isArray(marketDetails) ? marketDetails : [], success: true };
          } catch (error: any) {
            const status = error?.details?.status || error?.response?.status;
            if (status === 400) {
              this.logger.debug(`EventId ${eventId} is expired or invalid; cannot load market runners from API.`);
            } else {
              this.logger.debug(
                `Could not fetch getMatchDetail for eventId ${eventId}: ${error?.message || String(error)}.`,
              );
            }
            return { eventId, marketDetails: [], success: false };
          }
        })
      );

      // Process results and extract selectionIds
      for (let i = 0; i < eventIds.length; i++) {
        const eventId = eventIds[i];
        const result = matchDetailsResults[i];
        
        if (result.status === 'fulfilled' && result.value.success) {
          const markets = result.value.marketDetails;
          if (!Array.isArray(markets) || markets.length === 0) {
            continue;
          }

          const marketsMap = matchOddsBetsByEvent.get(eventId);
          
          if (marketsMap) {
            for (const [marketId, marketBets] of marketsMap.entries()) {
              const matchOddsMarket = this.resolveCatalogMarketNode(markets, marketId, marketBets, 'matchOdds');
              
              if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
                // Extract selectionIds from runners (same structure as pending bets API)
                const apiSelectionIds = matchOddsMarket.runners
                  .map((runner: any) => {
                    const selectionId = runner.selectionId;
                    const runnerName = (runner.runnerName || runner.name || '').toLowerCase();
                    // Skip Yes/No runners (Tied Match market) and Tie/Draw runners (Match Odds Including Tie)
                    if (runnerName === 'yes' || runnerName === 'no' || 
                        runnerName === 'tie' || runnerName === 'the draw' || runnerName === 'draw') {
                      return null;
                    }
                    return selectionId !== null && selectionId !== undefined ? String(selectionId) : null;
                  })
                  .filter((id): id is string => id !== null);
                
                this.logger.debug(
                  `Match Odds API (eventId ${eventId}, marketId ${marketId}): Found ${apiSelectionIds.length} runners from getMatchDetail. ` +
                  `SelectionIds: [${apiSelectionIds.join(', ')}]`,
                );
                
                // ✅ Use ONLY API selectionIds (source of truth for market runners)
                marketSelectionsMap.set(marketId, apiSelectionIds);
                this.logger.debug(
                  `Match Odds (eventId ${eventId}, marketId ${marketId}): Using ${apiSelectionIds.length} selectionIds from API: [${apiSelectionIds.join(', ')}]`,
                );
              } else {
                this.logger.warn(
                  `Match Odds market (marketId ${marketId}) could not be mapped to getMatchDetail nodes for eventId ${eventId}. Skipping MO runner list (do not fall back to bets).`,
                );
              }
            }
          }

          // Bookmaker-only events still need this branch (do not nest under matchOdds marketsMap).
          const bmMarketsMap = bookmakerBetsByEvent.get(eventId);
          if (bmMarketsMap) {
            for (const [bmMarketId, bmBets] of bmMarketsMap.entries()) {
              const apiBmMarket = this.resolveCatalogMarketNode(markets, bmMarketId, bmBets, 'bookmaker');
              if (apiBmMarket?.runners && Array.isArray(apiBmMarket.runners)) {
                const bmSelectionIds = apiBmMarket.runners
                  .map((r: any) =>
                    r?.selectionId !== null && r?.selectionId !== undefined ? String(r.selectionId) : null,
                  )
                  .filter((id): id is string => id !== null);
                marketSelectionsMap.set(bmMarketId, bmSelectionIds);
                this.logger.debug(
                  `Bookmaker API (eventId ${eventId}, marketId ${bmMarketId}): Using ${bmSelectionIds.length} runners from getMatchDetail: [${bmSelectionIds.join(', ')}]`,
                );
              } else {
                this.logger.warn(
                  `Bookmaker market (marketId ${bmMarketId}) not found in getMatchDetail for eventId ${eventId}. Skipping (do not fall back to bets).`,
                );
              }
            }
          }
        }
      }

      // ✅ Calculate positions using pure function (no side effects)
      const allPositions = calculateAllPositions(openBets, marketSelectionsMap);
      
      // Log calculated positions for debugging
      this.logger.debug(
        `Position calculation result: ` +
        `matchOdds=${allPositions.matchOdds ? 'present' : 'null'}, ` +
        `fancy=${allPositions.fancy?.length || 0} markets, ` +
        `bookmaker=${allPositions.bookmaker ? 'present' : 'null'}`,
      );

      // ✅ Transform response to new format: group by eventId, flatten structure
      const response: any = {};
      const tiedMatchMarketIds = new Set(
        openBets
          .filter((bet) => this.isTiedMatchMarketName(bet.marketName))
          .map((bet) => bet.marketId)
          .filter((id): id is string => Boolean(id)),
      );
      
      // Determine eventId (from query param or from bets)
      // If eventId query param provided, use it; otherwise use first bet's eventId
      let responseEventId: string | null = null;
      if (eventId) {
        responseEventId = eventId;
      } else if (openBets.length > 0) {
        // Get first non-null eventId from bets
        const firstEventId = openBets.find(bet => bet.eventId)?.eventId;
        if (firstEventId) {
          responseEventId = firstEventId;
        }
      }
      
      if (responseEventId) {
        response.eventId = responseEventId;
      }
      
      // Transform Match Odds: flatten runners to selectionId -> net
      if (allPositions.matchOdds && allPositions.matchOdds.length > 0) {
        // Merge all Match Odds markets (if multiple, combine their runners)
        // Keep TIED_MATCH markets separate from regular MATCH_ODDS.
        const matchOddsFlat: Record<string, number> = {};
        const tieMatchFlat: Record<string, number> = {};
        for (const matchOddsPos of allPositions.matchOdds) {
          const targetBucket = tiedMatchMarketIds.has(matchOddsPos.marketId)
            ? tieMatchFlat
            : matchOddsFlat;
          for (const [selectionId, runner] of Object.entries(matchOddsPos.runners)) {
            // If multiple markets have same selectionId, sum them
            targetBucket[selectionId] = (targetBucket[selectionId] || 0) + runner.net;
          }
        }
        if (Object.keys(matchOddsFlat).length > 0) {
          response.matchOdds = matchOddsFlat;
        }
        if (Object.keys(tieMatchFlat).length > 0) {
          response.tieMatch = tieMatchFlat;
        }
      }
      
      // Transform Bookmaker: flatten runners to selectionId -> net
      if (allPositions.bookmaker && allPositions.bookmaker.length > 0) {
        // Merge all Bookmaker markets (if multiple, combine their runners)
        const bookmakerFlat: Record<string, number> = {};
        for (const bookmakerPos of allPositions.bookmaker) {
          for (const [selectionId, runner] of Object.entries(bookmakerPos.runners)) {
            // If multiple markets have same selectionId, sum them
            bookmakerFlat[selectionId] = (bookmakerFlat[selectionId] || 0) + runner.net;
          }
        }
        if (Object.keys(bookmakerFlat).length > 0) {
          response.bookmaker = bookmakerFlat;
        }
      }
      
      // Transform Fancy: convert array to object with fancyId as key
      if (allPositions.fancy && allPositions.fancy.length > 0) {
        const fancyFlat: Record<string, { YES: number; NO: number }> = {};
        for (const fancyPos of allPositions.fancy) {
          fancyFlat[fancyPos.fancyId] = fancyPos.positions;
        }
        if (Object.keys(fancyFlat).length > 0) {
          response.fancy = fancyFlat;
        }
      }

      return {
        success: true,
        data: response,
        betCount: openBets.length,
      };
    } catch (error) {
      this.logger.error(`Error calculating positions for user ${user.id}:`, error);

      throw new HttpException(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to calculate positions',
          code: 'POSITION_CALCULATION_FAILED',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * ✅ GET /positions/market/:marketId
   * 
   * Returns positions for a specific market (Match Odds or Bookmaker only).
   * 
   * @param marketId - Market ID
   */
  @Get('market/:marketId')
  async getMarketPositions(
    @CurrentUser() user: User,
    @Param('marketId') marketId: string,
  ) {
    try {
      if (!marketId) {
        throw new HttpException(
          {
            success: false,
            error: 'marketId is required',
            code: 'MISSING_MARKET_ID',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Load open bets for this specific market
      const openBets = await this.prisma.bet.findMany({
        where: {
          userId: user.id,
          marketId,
          status: BetStatus.PENDING,
        },
        select: {
          id: true,
          gtype: true,
          marketId: true,
          eventId: true,
          selectionId: true,
          betType: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
          winAmount: true,
          lossAmount: true,
          betName: true,
          status: true,
        },
      });

      if (openBets.length === 0) {
        return {
          success: true,
          data: null,
          message: 'No open bets found for this market',
        };
      }

      // Determine market type from first bet
      const firstBetGtype = (openBets[0]?.gtype || '').toLowerCase();
      let marketPosition: MatchOddsPosition | BookmakerPosition | null = null;

      if (firstBetGtype === 'matchodds' || firstBetGtype === 'match') {
        // ✅ CRITICAL: Match Odds runners MUST come from Detail Match API
        const eventId = openBets[0]?.eventId;
        let marketSelections: string[] = [];
        
        if (eventId) {
          try {
            // Call Detail Match API to get market runners
            const marketDetails = await this.aggregatorService.getMatchDetail(eventId);
            const markets = Array.isArray(marketDetails) ? marketDetails : [];
            
            const apiMarket = this.resolveCatalogMarketNode(markets, marketId, openBets, 'matchOdds');
            
            if (apiMarket && apiMarket.runners && Array.isArray(apiMarket.runners)) {
              // Extract selectionIds from API runners (source of truth)
              marketSelections = apiMarket.runners
                .map((r: any) => {
                  const selectionId = r.selectionId;
                  return selectionId !== null && selectionId !== undefined ? String(selectionId) : null;
                })
                .filter((id): id is string => id !== null);
              
              this.logger.debug(
                `Market ${marketId} (eventId ${eventId}): Found ${marketSelections.length} runners from API: [${marketSelections.join(', ')}]`,
              );
            } else {
              this.logger.warn(
                `Market ${marketId} (eventId ${eventId}): Not found in API response. Cannot calculate Match Odds position.`,
              );
            }
          } catch (error: any) {
            const status = error?.details?.status || error?.response?.status;
            if (status === 400) {
              this.logger.debug(
                `EventId ${eventId} is expired or invalid. Cannot calculate Match Odds position.`,
              );
            } else {
              this.logger.warn(
                `Failed to fetch market details for eventId ${eventId}: ${error?.message || String(error)}. Cannot calculate Match Odds position.`,
              );
            }
          }
        }
        
        // Only calculate if runners from API are available
        if (marketSelections.length > 0) {
          marketPosition = this.positionService.calculateMatchOddsPosition(
            openBets,
            marketId,
            marketSelections,
          );
        }
      } else if (
        firstBetGtype === 'bookmaker' ||
        (firstBetGtype.startsWith('match') &&
          firstBetGtype !== 'match' &&
          firstBetGtype !== 'matchodds')
      ) {
        // Bookmaker: full runner list from getMatchDetail by marketId (same as Match Odds), never from bets.
        const eventId = openBets[0]?.eventId;
        let marketSelections: string[] = [];
        if (eventId) {
          try {
            const marketDetails = await this.aggregatorService.getMatchDetail(eventId);
            const markets = Array.isArray(marketDetails) ? marketDetails : [];
            const apiMarket = this.resolveCatalogMarketNode(markets, marketId, openBets, 'bookmaker');
            if (apiMarket?.runners && Array.isArray(apiMarket.runners)) {
              marketSelections = apiMarket.runners
                .map((r: any) =>
                  r?.selectionId !== null && r?.selectionId !== undefined ? String(r.selectionId) : null,
                )
                .filter((id): id is string => id !== null);
            } else {
              this.logger.warn(
                `Bookmaker market ${marketId} (eventId ${eventId}): not mapped to catalog node; cannot calculate position without full runner list.`,
              );
            }
          } catch (error: any) {
            this.logger.warn(
              `Failed to fetch market details for bookmaker eventId ${eventId}: ${error?.message || String(error)}.`,
            );
          }
        }
        if (marketSelections.length > 0) {
          marketPosition = this.positionService.calculateBookmakerPosition(
            openBets,
            marketId,
            marketSelections,
          );
        }
      } else {
        throw new HttpException(
          {
            success: false,
            error: `Market type '${firstBetGtype}' not supported. Only Match Odds and Bookmaker markets are supported for this endpoint.`,
            code: 'UNSUPPORTED_MARKET_TYPE',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      return {
        success: true,
        data: marketPosition,
        betCount: openBets.length,
      };
    } catch (error) {
      this.logger.error(
        `Error calculating market positions for user ${user.id}, market ${marketId}:`,
        error,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to calculate market positions',
          code: 'POSITION_CALCULATION_FAILED',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * ✅ GET /positions/fancy
   * 
   * Returns all Fancy positions for the authenticated user.
   */
  @Get('fancy')
  async getFancyPositions(@CurrentUser() user: User) {
    try {
      // Load all Fancy bets
      const fancyBets = await this.prisma.bet.findMany({
        where: {
          userId: user.id,
          status: BetStatus.PENDING,
          gtype: 'fancy',
        },
        select: {
          id: true,
          gtype: true,
          marketId: true,
          eventId: true,
          selectionId: true,
          betType: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
          winAmount: true,
          lossAmount: true,
          betName: true,
          status: true,
        },
      });

      // Calculate Fancy positions
      const fancyPositions = this.positionService.calculateFancyPosition(fancyBets);

      return {
        success: true,
        data: fancyPositions,
        betCount: fancyBets.length,
      };
    } catch (error) {
      this.logger.error(
        `Error calculating fancy positions for user ${user.id}:`,
        error,
      );

      throw new HttpException(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to calculate fancy positions',
          code: 'POSITION_CALCULATION_FAILED',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

