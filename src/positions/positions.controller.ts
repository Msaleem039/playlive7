import {
  Controller,
  Get,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
  Param,
} from '@nestjs/common';
import { PositionService } from './position.service';
import { PrismaService } from '../prisma/prisma.service';
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
  ) {}

  /**
   * ✅ GET /positions
   * 
   * Returns all positions (P/L projections) for the authenticated user across all market types.
   * 
   * 🚨 CRITICAL RULES:
   * - Position is calculated fresh from ALL open bets (never stored in DB)
   * - Markets are completely isolated (Match Odds, Fancy, Bookmaker)
   * - Position is UI/display only - does not affect wallet or exposure
   * 
   * Response Format:
   * {
   *   "matchOdds": {
   *     "marketId": "...",
   *     "positions": {
   *       "selectionId": { "profit": number, "loss": number }
   *     }
   *   },
   *   "fancy": [
   *     {
   *       "fancyId": "eventId_selectionId",
   *       "name": "...",
   *       "positions": { "YES": number, "NO": number }
   *     }
   *   ],
   *   "bookmaker": {
   *     "marketId": "...",
   *     "positions": {
   *       "selectionId": number  // net position
   *     }
   *   }
   * }
   */
  @Get()
  async getAllPositions(@CurrentUser() user: User) {
    try {
      // ✅ Load ALL open bets for this user (read-only, no wallet/DB modifications)
      const openBets = await this.prisma.bet.findMany({
        where: {
          userId: user.id,
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

      this.logger.debug(
        `Calculating positions for user ${user.id}: Found ${openBets.length} open bets`,
      );

      // ✅ Calculate positions using pure function (no side effects)
      const allPositions = calculateAllPositions(openBets);

      return {
        success: true,
        data: allPositions,
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
        // Match Odds position
        marketPosition = this.positionService.calculateMatchOddsPosition(
          openBets,
          marketId,
        );
      } else if (
        firstBetGtype === 'bookmaker' ||
        (firstBetGtype.startsWith('match') &&
          firstBetGtype !== 'match' &&
          firstBetGtype !== 'matchodds')
      ) {
        // Bookmaker position
        marketPosition = this.positionService.calculateBookmakerPosition(
          openBets,
          marketId,
        );
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

