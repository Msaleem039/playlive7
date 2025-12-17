import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  ParseBoolPipe,
  ParseIntPipe,
  Optional,
  Delete,
} from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole, MarketType } from '@prisma/client';
import type { User } from '@prisma/client';

class SettleFancyDto {
  eventId: string;
  selectionId: string;
  decisionRun?: number | null;
  isCancel: boolean;
  marketId?: string | null;
}

class SettleMatchOddsDto {
  eventId: string;
  marketId: string;
  winnerSelectionId: string;
}

class SettleBookmakerDto {
  eventId: string;
  marketId: string;
  winnerSelectionId: string;
}

class RollbackSettlementDto {
  settlementId: string;
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
    );
  }

  /**
   * Settle match odds bets (Admin only)
   */
  @Post('match-odds')
  async settleMatchOdds(
    @Body() dto: SettleMatchOddsDto,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleMatchOddsManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      user.id,
    );
  }

  /**
   * Settle bookmaker bets (Admin only)
   */
  @Post('bookmaker')
  async settleBookmaker(
    @Body() dto: SettleBookmakerDto,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.settleBookmakerManual(
      dto.eventId,
      dto.marketId,
      dto.winnerSelectionId,
      user.id,
    );
  }

  /**
   * Rollback a settlement (Admin only)
   */
  @Post('rollback')
  async rollback(
    @Body() dto: RollbackSettlementDto,
    @CurrentUser() user: User,
  ) {
    return this.settlementService.rollbackSettlement(
      dto.settlementId,
      user.id,
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
   * Get pending bets for a specific market type (Admin only)
   * GET /admin/settlement/pending/fancy
   * GET /admin/settlement/pending/match-odds
   * GET /admin/settlement/pending/bookmaker
   */
  @Get('pending/:marketType')
  async getPendingBetsByMarketType(
    @Param('marketType') marketType: string,
  ) {
    const validTypes = ['fancy', 'match-odds', 'bookmaker'];
    
    if (!validTypes.includes(marketType)) {
      throw new BadRequestException(
        `Invalid market type: ${marketType}. Must be one of: ${validTypes.join(', ')}`,
      );
    }

    return this.settlementService.getPendingBetsByMarketType(
      marketType as 'fancy' | 'match-odds' | 'bookmaker',
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
      const validMarketTypes = ['FANCY', 'MATCH_ODDS', 'BOOKMAKER'];
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
}
