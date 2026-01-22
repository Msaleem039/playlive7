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
  ) {}

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
      
      // ✅ Extract ALL unique selectionIds from bets for each market
      // These selectionIds match what the UI/Match Detail API expects (e.g., 681460, 63361)
      for (const [eventId, marketsMap] of matchOddsBetsByEvent.entries()) {
        for (const [marketId, marketBets] of marketsMap.entries()) {
          // Get all unique selectionIds from bets in this market
          const selectionIds = Array.from(
            new Set(
              marketBets
                .map((bet) => bet.selectionId)
                .filter((id): id is number => id !== null && id !== undefined)
                .map((id) => String(id))
            )
          );
          
          if (selectionIds.length > 0) {
            marketSelectionsMap.set(marketId, selectionIds);
            this.logger.debug(
              `Match Odds (eventId ${eventId}, marketId ${marketId}): Using ${selectionIds.length} selectionIds from bets: [${selectionIds.join(', ')}]`,
            );
          }
        }
      }
      
      // ✅ CRITICAL: Get ALL runners from getBookmakerFancy API (has correct selectionIds for UI)
      // This ensures we include ALL runners, even if there are no bets on them
      for (const [eventId, marketsMap] of matchOddsBetsByEvent.entries()) {
        try {
          // Use getBookmakerFancy which has Match Odds with correct selectionIds
          const bookmakerFancyData = await this.cricketIdService.getBookmakerFancy(eventId);
          const markets = Array.isArray(bookmakerFancyData?.data) ? bookmakerFancyData.data : [];
          
          // Find Match Odds market (mname === 'MATCH_ODDS')
          const matchOddsMarket = markets.find((market: any) => {
            const mname = (market.mname || '').toUpperCase();
            return mname === 'MATCH_ODDS';
          });
          
          if (matchOddsMarket && matchOddsMarket.section && Array.isArray(matchOddsMarket.section)) {
            // Extract selectionIds from sections (each section.sid is a runner/selectionId)
            const apiSelectionIds = matchOddsMarket.section
              .map((section: any) => {
                const selectionId = section.sid;
                return selectionId !== null && selectionId !== undefined ? String(selectionId) : null;
              })
              .filter((id): id is string => id !== null);
            
            this.logger.debug(
              `Match Odds API (eventId ${eventId}): Found ${apiSelectionIds.length} runners from getBookmakerFancy. ` +
              `SelectionIds: [${apiSelectionIds.join(', ')}]`,
            );
            
            // ✅ Use API selectionIds for ALL markets in this eventId
            // This ensures ALL runners are included, even without bets
            for (const [marketId] of marketsMap.entries()) {
              // Merge bet selectionIds with API selectionIds (API takes priority for completeness)
              const betSelectionIds = marketSelectionsMap.get(marketId) || [];
              const allSelectionIds = Array.from(new Set([...apiSelectionIds, ...betSelectionIds]));
              
              marketSelectionsMap.set(marketId, allSelectionIds);
              this.logger.debug(
                `Match Odds (eventId ${eventId}, marketId ${marketId}): Using ${allSelectionIds.length} selectionIds ` +
                `(API: ${apiSelectionIds.length}, Bets: ${betSelectionIds.length}): [${allSelectionIds.join(', ')}]`,
              );
            }
          } else {
            this.logger.warn(
              `Match Odds market not found in getBookmakerFancy for eventId ${eventId}. Using bet selectionIds only.`,
            );
          }
        } catch (error: any) {
          // API call failed - continue using bet selectionIds only
          this.logger.debug(
            `Could not fetch getBookmakerFancy for eventId ${eventId}: ${error?.message || String(error)}. Using bet selectionIds only.`,
          );
        }
      }
      
      // For non-Match Odds markets (Bookmaker, Fancy), derive from bets as fallback
      const otherBetsByMarket = new Map<string, typeof openBets>();
      for (const bet of openBets) {
        const betGtype = (bet.gtype || '').toLowerCase();
        const isMatchOdds = betGtype === 'matchodds' || betGtype === 'match';
        if (!isMatchOdds && bet.marketId) {
          if (!otherBetsByMarket.has(bet.marketId)) {
            otherBetsByMarket.set(bet.marketId, []);
          }
          otherBetsByMarket.get(bet.marketId)!.push(bet);
        }
      }
      
      // Extract runners from bets for non-Match Odds markets
      for (const [marketId, marketBets] of otherBetsByMarket.entries()) {
        if (!marketSelectionsMap.has(marketId)) {
          const selectionIds = Array.from(
            new Set(
              marketBets
                .map((bet) => bet.selectionId)
                .filter((id): id is number => id !== null && id !== undefined)
                .map((id) => String(id))
            )
          );
          if (selectionIds.length > 0) {
            marketSelectionsMap.set(marketId, selectionIds);
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
        const matchOddsFlat: Record<string, number> = {};
        for (const matchOddsPos of allPositions.matchOdds) {
          for (const [selectionId, runner] of Object.entries(matchOddsPos.runners)) {
            // If multiple markets have same selectionId, sum them
            matchOddsFlat[selectionId] = (matchOddsFlat[selectionId] || 0) + runner.net;
          }
        }
        if (Object.keys(matchOddsFlat).length > 0) {
          response.matchOdds = matchOddsFlat;
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
            
            // Find market by marketId
            const apiMarket = markets.find((m: any) => m.marketId === marketId);
            
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
        // Bookmaker position - derive runners from bets (not from API)
        const marketSelections = Array.from(
          new Set(
            openBets
              .map((bet) => bet.selectionId)
              .filter((id): id is number => id !== null && id !== undefined)
              .map((id) => String(id))
          )
        );
        
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

