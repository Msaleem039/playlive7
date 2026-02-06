import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  Delete,
} from '@nestjs/common';
import { IsNotEmpty, IsString, IsOptional, IsBoolean, IsNumber, IsArray } from 'class-validator';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole, MarketType } from '@prisma/client';
import type { User } from '@prisma/client';

class SettleFancyDto {
  @IsNotEmpty()
  @IsString()
  eventId: string;

  @IsNotEmpty()
  @IsString()
  selectionId: string;

  @IsOptional()
  @IsNumber()
  decisionRun?: number | null;

  @IsNotEmpty()
  @IsBoolean()
  isCancel: boolean;

  @IsOptional()
  @IsString()
  marketId?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  betIds?: string[]; // Optional: settle only specific bets. If not provided, settles all pending bets for the market
}

class SettleMarketDto {
  @IsNotEmpty()
  @IsString()
  eventId: string;

  @IsNotEmpty()
  @IsString()
  marketId: string;

  @IsNotEmpty()
  @IsString()
  winnerSelectionId: string;

  @IsNotEmpty()
  @IsString()
  marketType: 'MATCH_ODDS' | 'BOOKMAKER' | 'TIED_MATCH'; // Market type: MATCH_ODDS, BOOKMAKER, or TIED_MATCH

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  betIds?: string[]; // Optional: settle only specific bets. If not provided, settles all pending bets for the market
}

class SettleTiedMatchDto {
  @IsNotEmpty()
  @IsString()
  eventId: string;

  @IsNotEmpty()
  @IsString()
  marketId: string;

  @IsNotEmpty()
  @IsString()
  winnerSelectionId: string; // 37302 for Yes, 37303 for No

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  betIds?: string[]; // Optional: settle only specific bets. If not provided, settles all pending bets for the market
}

@Controller('admin/settlement')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  'SETTLEMENT_ADMIN' as UserRole,
)
export class SettlementAdminController {
  constructor(private readonly settlementService: SettlementService) {}

  /**
   * Settle fancy bets manually (Admin only)
   */
  @Post('fancy')
  async settleFancy(
    @Body() dto: SettleFancyDto,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleFancyManual(
      dto.eventId,
      dto.selectionId,
      dto.decisionRun ?? null,
      dto.isCancel,
      dto.marketId ?? null,
      user.id,
      dto.betIds, // Pass optional betIds array
    );
  }

  /**
   * Settle market bets (Match Odds or Bookmaker) - Unified endpoint
   * POST /admin/settlement/market
   */
  @Post('market')
  async settleMarket(
    @Body() dto: SettleMarketDto,
    @CurrentUser() user: User,
  ) {
    // Validate DTO
    if (!dto.eventId || !dto.marketId || !dto.winnerSelectionId || !dto.marketType) {
      throw new BadRequestException(
        `Missing required fields. Received: eventId=${dto?.eventId}, marketId=${dto?.marketId}, winnerSelectionId=${dto?.winnerSelectionId}, marketType=${dto?.marketType}`,
      );
    }

    // Validate marketType
    if (dto.marketType !== 'MATCH_ODDS' && dto.marketType !== 'BOOKMAKER' && dto.marketType !== 'TIED_MATCH') {
      throw new BadRequestException(
        `Invalid marketType: ${dto.marketType}. Must be either 'MATCH_ODDS', 'BOOKMAKER', or 'TIED_MATCH'`,
      );
    }

    // Route to appropriate settlement function
    if (dto.marketType === 'BOOKMAKER') {
      return this.settlementService.settleBookmakerManual(
        dto.eventId,
        dto.marketId,
        dto.winnerSelectionId,
        user.id,
        dto.betIds,
      );
    }

    if (dto.marketType === 'TIED_MATCH') {
      return this.settlementService.settleTiedMatchManual(
        dto.eventId,
        dto.marketId,
        dto.winnerSelectionId,
        user.id,
        dto.betIds,
      );
    }

    // MATCH_ODDS
    return this.settlementService.settleMarketManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      MarketType.MATCH_ODDS,
      user.id,
      dto.betIds,
    );
  }

  /**
   * Settle Tied Match bets manually (Admin only)
   * POST /admin/settlement/tied-match
   * 
   * Tied Match is a Yes/No market where:
   * - Yes (selectionId 37302) = Match will be tied
   * - No (selectionId 37303) = Match will not be tied
   * 
   * Request Body:
   * {
   *   "eventId": "35226952",
   *   "marketId": "1.253607053",
   *   "winnerSelectionId": "37302",  // 37302 for Yes, 37303 for No
   *   "betIds": ["bet1", "bet2"]      // Optional: settle only specific bets
   * }
   */
  @Post('tied-match')
  async settleTiedMatch(
    @Body() dto: SettleTiedMatchDto,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleTiedMatchManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      user.id,
      dto.betIds,
    );
  }

  /**
   * @deprecated Use POST /admin/settlement/market instead
   * Settle match odds bets (Admin only)
   */
  @Post('match-odds')
  async settleMatchOdds(
    @Body() dto: Omit<SettleMarketDto, 'marketType'>,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleMarketManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      MarketType.MATCH_ODDS,
      user.id,
      dto.betIds,
    );
  }

  /**
   * @deprecated Use POST /admin/settlement/market instead
   * Settle bookmaker bets (Admin only)
   */
  @Post('bookmaker')
  async settleBookmaker(
    @Body() dto: Omit<SettleMarketDto, 'marketType'>,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleBookmakerManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      user.id,
      dto.betIds,
    );
  }

  /**
   * Get all pending bets grouped by match (Admin only)
   * Shows fancy, match-odds, and bookmaker pending bets for each match
   * GET /admin/settlement/pending
   */
  @Get('pending')
  async getPendingBetsByMatch() {
    return this.settlementService.getPendingBetsByMatch();
  }

  /**
   * Get pending fancy markets only (all users)
   * GET /admin/settlement/pending/fancy-markets
   */
  @Get('pending/fancy-markets')
  async getPendingFancyMarkets() {
    return this.settlementService.getPendingFancyMarkets();
  }

  /**
   * Get pending bookmaker markets only (all users)
   * GET /admin/settlement/pending/bookmaker-markets
   */
  @Get('pending/bookmaker-markets')
  async getPendingBookmakerMarkets() {
    return this.settlementService.getPendingBookmakerMarkets();
  }

  /**
   * Get pending bookmaker and match odds markets combined (all users)
   * GET /admin/settlement/pending/markets
   */
  @Get('pending/markets')
  async getPendingMarketOddsAndBookmaker() {
    return this.settlementService.getPendingMarketOddsAndBookmaker();
  }

  /**
   * Get pending bets for a specific market type (Admin only)
   * GET /admin/settlement/pending/fancy
   * GET /admin/settlement/pending/match-odds
   * GET /admin/settlement/pending/bookmaker
   * GET /admin/settlement/pending/tied-match
   */
  @Get('pending/:marketType')
  async getPendingBetsByMarketType(
    @Param('marketType') marketType: string,
  ) {
    const validTypes = ['fancy', 'match-odds', 'bookmaker', 'tied-match'];
    
    if (!validTypes.includes(marketType)) {
      throw new BadRequestException(
        `Invalid market type: ${marketType}. Must be one of: ${validTypes.join(', ')}`,
      );
    }

    return this.settlementService.getPendingBetsByMarketType(
      marketType as 'fancy' | 'match-odds' | 'bookmaker' | 'tied-match',
    );
  }

  /**
   * Get all settlement history (Admin only)
   * GET /admin/settlement/history
   * 
   * Query Parameters:
   * - eventId: Filter by event ID
   * - marketType: Filter by market type (FANCY, MATCH_ODDS, BOOKMAKER)
   * - isRollback: Filter by rollback status (true/false)
   * - settledBy: Filter by who settled (user ID or "AUTO")
   * - startDate: Filter from date (ISO string)
   * - endDate: Filter to date (ISO string)
   * - limit: Number of results (default: 100)
   * - offset: Pagination offset (default: 0)
   */
  @Get('history')
  async getSettlementHistory(
    @Query('eventId') eventId?: string,
    @Query('marketType') marketType?: string,
    @Query('isRollback') isRollback?: string,
    @Query('settledBy') settledBy?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const filters: any = {};

    if (eventId) {
      filters.eventId = eventId;
    }

    if (marketType) {
      const validMarketTypes = ['FANCY', 'MATCH_ODDS', 'BOOKMAKER', 'TIED_MATCH'];
      if (!validMarketTypes.includes(marketType.toUpperCase())) {
        throw new BadRequestException(
          `Invalid market type: ${marketType}. Must be one of: ${validMarketTypes.join(', ')}`,
        );
      }
      filters.marketType = marketType.toUpperCase() as MarketType;
    }

    if (isRollback !== undefined) {
      filters.isRollback = isRollback === 'true';
    }

    if (settledBy) {
      filters.settledBy = settledBy;
    }

    if (startDate) {
      filters.startDate = new Date(startDate);
    }

    if (endDate) {
      filters.endDate = new Date(endDate);
    }

    if (limit) {
      filters.limit = parseInt(limit, 10);
      if (isNaN(filters.limit) || filters.limit < 1) {
        throw new BadRequestException('limit must be a positive number');
      }
    }

    if (offset) {
      filters.offset = parseInt(offset, 10);
      if (isNaN(filters.offset) || filters.offset < 0) {
        throw new BadRequestException('offset must be a non-negative number');
      }
    }

    return this.settlementService.getAllSettlements(filters);
  }

  /**
   * Get a single settlement by ID with full details (Admin only)
   * GET /admin/settlement/history/:settlementId
   */
  @Get('history/:settlementId')
  async getSettlementById(@Param('settlementId') settlementId: string) {
    return this.settlementService.getSettlementById(settlementId);
  }

  /**
   * Get bet history for a specific user (Admin, Agent, and Client access)
   * GET /admin/settlement/bets/user/:userId
   * 
   * Query Parameters:
   * - status (optional): Filter by bet status (PENDING, WON, LOST, CANCELLED)
   * - limit (optional): Number of results per page (default: 20)
   * - offset (optional): Pagination offset (default: 0)
   * - startDate (optional): Filter from date (ISO string)
   * - endDate (optional): Filter to date (ISO string)
   * 
   * Examples:
   * - GET /admin/settlement/bets/user/user123
   * - GET /admin/settlement/bets/user/user123?status=PENDING
   * - GET /admin/settlement/bets/user/user123?status=WON&limit=50
   * - GET /admin/settlement/bets/user/user123?startDate=2024-01-01T00:00:00.000Z&endDate=2024-01-31T23:59:59.999Z
   */
  @Get('bets/user/:userId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    'SETTLEMENT_ADMIN' as UserRole,
    UserRole.AGENT,
    UserRole.CLIENT,
  )
  async getUserBetHistory(
    @Param('userId') userId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // Validate status if provided
    if (status) {
      const validStatuses = ['PENDING', 'WON', 'LOST', 'CANCELLED'];
      if (!validStatuses.includes(status.toUpperCase())) {
        throw new BadRequestException(
          `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
        );
      }
    }

    const filters: any = {
      userId,
      ...(status && { status: status.toUpperCase() }),
    };

    // Set default limit to 20 if not provided
    if (limit) {
      filters.limit = parseInt(limit, 10);
      if (isNaN(filters.limit) || filters.limit < 1) {
        throw new BadRequestException('limit must be a positive number');
      }
    } else {
      filters.limit = 20; // Default pagination limit
    }

    if (offset) {
      filters.offset = parseInt(offset, 10);
      if (isNaN(filters.offset) || filters.offset < 0) {
        throw new BadRequestException('offset must be a non-negative number');
      }
    } else {
      filters.offset = 0; // Default offset
    }

    if (startDate) {
      filters.startDate = new Date(startDate);
    }

    if (endDate) {
      filters.endDate = new Date(endDate);
    }

    return this.settlementService.getUserBetHistory(filters);
  }

  /**
   * Delete a bet for a specific user (Admin only)
   * DELETE /admin/settlement/bet/:betIdOrSettlementId
   * 
   * This will:
   * - Refund the user's wallet balance and release liability
   * - Create a refund transaction record
   * - Delete the bet (only if status is PENDING)
   * 
   * You can use either:
   * - Bet ID: DELETE /admin/settlement/bet/cmirm7k73000kv380tjra2djr
   * - Settlement ID: DELETE /admin/settlement/bet/705374333_690220
   */
  @Delete('bet/:betIdOrSettlementId')
  async deleteBet(
    @Param('betIdOrSettlementId') betIdOrSettlementId: string,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.deleteBet(betIdOrSettlementId, user.id);
  }

  /**
   * Rollback a previously settled settlement (Admin only)
   * POST /admin/settlement/rollback
   * 
   * This will:
   * - Reset all settled bets (WON/LOST/CANCELLED) back to PENDING
   * - Restore wallet balance and liability for all affected users
   * - Mark the settlement as rolled back
   * - Delete hierarchical PnL records
   * - Recalculate P/L for all affected users
   * 
   * Request Body:
   * {
   *   "settlementId": "CRICKET:MATCHODDS:35100660:6571503686236",  // Required: Settlement ID to rollback
   *   "betIds": ["bet1", "bet2", "bet3"]                           // Optional: Specific bet IDs to rollback. If not provided, rolls back ALL bets for the settlement
   * }
   * 
   * Response:
   * {
   *   "success": true,
   *   "message": "Settlement rolled back successfully"
   * }
   */
  @Post('rollback')
  async rollbackSettlement(
    @Body() body: { settlementId: string; betIds?: string[] },
    @CurrentUser() user: User,
  ) {
    if (!body.settlementId) {
      throw new BadRequestException('settlementId is required');
    }

    return this.settlementService.rollbackSettlement(
      body.settlementId,
      user.id,
      body.betIds,
    );
  }

  /**
   * Cancel multiple bets and refund all affected users (Admin only)
   * Accessible by: SUPER_ADMIN, ADMIN, SETTLEMENT_ADMIN
   * POST /admin/settlement/cancel-bets
   * 
   * This will:
   * - Cancel all pending bets matching the criteria
   * - Refund all users who placed those bets
   * - Release liability for all cancelled bets
   * - Create refund transaction records
   * 
   * Request Body (at least one filter required):
   * {
   *   "settlementId": "CRICKET:MATCHODDS:35100660:6571503686236",  // Optional: Cancel by settlementId
   *   "eventId": "35100660",                                        // Optional: Cancel all bets for event
   *   "marketId": "6571503686236",                                  // Optional: Cancel bets for specific market
   *   "selectionId": "5728187",                                     // Optional: Cancel bets for specific selection (Fancy)
   *   "betIds": ["bet1", "bet2", "bet3"]                           // Optional: Cancel specific bet IDs
   * }
   * 
   * Examples:
   * 1. Cancel all bets for a market:
   *    POST /admin/settlement/cancel-bets
   *    { "eventId": "35100660", "marketId": "6571503686236" }
   * 
   * 2. Cancel all bets for an event:
   *    POST /admin/settlement/cancel-bets
   *    { "eventId": "35100660" }
   * 
   * 3. Cancel all fancy bets for a selection:
   *    POST /admin/settlement/cancel-bets
   *    { "eventId": "35100660", "selectionId": "12345" }
   * 
   * 4. Cancel specific bets by ID:
   *    POST /admin/settlement/cancel-bets
   *    { "betIds": ["bet1", "bet2", "bet3"] }
   * 
   * 5. Cancel by settlementId:
   *    POST /admin/settlement/cancel-bets
   *    { "settlementId": "CRICKET:MATCHODDS:35100660:6571503686236" }
   * 
   * Response:
   * {
   *   "success": true,
   *   "message": "Successfully cancelled X bet(s) and refunded Y user(s)",
   *   "data": {
   *     "cancelledBetsCount": 10,
   *     "refundedUsersCount": 5,
   *     "totalRefundAmount": 1500.00,
   *     "cancelledBets": [...]
   *   }
   * }
   */
  @Post('cancel-bets')
  async cancelBetsBulk(
    @Body() filters: {
      settlementId?: string;
      eventId?: string;
      marketId?: string;
      selectionId?: string;
      betIds?: string[];
    },
    @CurrentUser() user: User,
  ) {
    // Validate that at least one filter is provided
    if (
      !filters.settlementId &&
      !filters.eventId &&
      (!filters.betIds || filters.betIds.length === 0)
    ) {
      throw new BadRequestException(
        'At least one filter must be provided: settlementId, eventId, or betIds',
      );
    }

    return this.settlementService.cancelBetsBulk(user.id, filters);
  }
}
