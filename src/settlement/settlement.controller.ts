import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import {
  ManualSettleDto,
  ManualSettleBySettlementIdDto,
  ManualSettleWithResultDto,
} from './dto/manual-settle.dto';
import { BetStatus } from '@prisma/client';

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

  @Post('manual/with-result')
  async manualSettleWithResult(@Body() body: ManualSettleWithResultDto) {
    // This uses manually provided result
    return this.settlement.settleBySettlementIdWithManualResult(
      body.settlement_id,
      body.winner,
    );
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
}
