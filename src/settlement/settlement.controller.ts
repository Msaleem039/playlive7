import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Param,
  UseGuards,
} from '@nestjs/common';
import { SettlementService } from './settlement.service';
import {
  ManualSettleDto,
  ManualSettleBySettlementIdDto,
  ReverseSettlementDto,
  SettleSingleSessionBetDto,
} from './dto/manual-settle.dto';
import { BetStatus } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@Controller('settlement')
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Get('manual')
  async manualSettle(@Query() query: ManualSettleDto) {
    return this.settlement.settleMatch(query.match_id);
  }

  @Get('manual/by-settlement-id')
  async manualSettleBySettlementId(
    @Query() query: ManualSettleBySettlementIdDto,
  ) {
    // This fetches result from API
    return this.settlement.settleBySettlementId(query.settlement_id);
  }


  /**
   * Get list of settlement_ids that need settlement
   * Returns settlement_ids with match info and pending bet counts
   */
  @Get('pending')
  async getPendingSettlements() {
    return this.settlement.getSettlementIdsNeedingSettlement();
  }

  /**
   * Get details for a specific settlement_id
   * Returns match info, all bets, and their status
   */
  @Get('details')
  async getSettlementDetails(@Query('settlement_id') settlementId: string) {
    if (!settlementId) {
      return {
        success: false,
        message: 'settlement_id query parameter is required',
      };
    }
    const details = await this.settlement.getSettlementDetails(settlementId);
    if (!details) {
      return {
        success: false,
        message: `No bets found for settlement_id: ${settlementId}`,
      };
    }
    return { success: true, ...details };
  }

  /**
   * Get bets with settlement status
   * Query params: status, match_id, settlement_id, user_id, limit
   */
  @Get('bets')
  async getBetsWithStatus(
    @Query('status') status?: BetStatus,
    @Query('match_id') matchId?: string,
    @Query('settlement_id') settlementId?: string,
    @Query('user_id') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.settlement.getBetsWithStatus({
      status: status as BetStatus | undefined,
      matchId,
      settlementId,
      userId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * Get all pending bets of the currently logged-in user
   */
  @Get('bets/me/pending')
  @UseGuards(JwtAuthGuard)
  async getMyPendingBets(@CurrentUser() user: User) {
    return this.settlement.getBetsWithStatus({
      status: BetStatus.PENDING,
      userId: user.id,
    });
  }

  /**
   * Get all settlement results (all settled bets)
   * Query params: match_id, settlement_id, user_id, status (WON/LOST), limit, offset
   */
  @Get('results')
  async getAllSettlementResults(
    @Query('match_id') matchId?: string,
    @Query('settlement_id') settlementId?: string,
    @Query('user_id') userId?: string,
    @Query('status') status?: BetStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.settlement.getAllSettlementResults({
      matchId,
      settlementId,
      userId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Reverse a settlement
   * This will revert bet status to PENDING and reverse wallet transactions
   */
  @Post('reverse')
  async reverseSettlement(@Body() body: ReverseSettlementDto) {
    return this.settlement.reverseSettlement(body.settlement_id);
  }

  /**
   * Get pending settlements for a specific match
   */
  @Get('pending/match/:matchId')
  async getPendingSettlementsByMatch(@Param('matchId') matchId: string) {
    return this.settlement.getPendingSettlementsByMatch(matchId);
  }

  /**
   * Settle single session bet by match_id, selection_id, gtype, bet_name
   * Similar to PHP's settleSingleSessionBet()
   * 
   * @example POST /settlement/manual/session-bet
   * Body: {
   *   "match_id": "match123",
   *   "selection_id": 1,
   *   "gtype": "fancy1",
   *   "bet_name": "Over 10.5",
   *   "winner_id": 15
   * }
   */
  @Post('manual/session-bet')
  async settleSingleSessionBet(@Body() body: SettleSingleSessionBetDto) {
    return this.settlement.settleSingleSessionBet(
      body.match_id,
      body.selection_id,
      body.gtype,
      body.bet_name,
      body.winner_id,
    );
  }
}
