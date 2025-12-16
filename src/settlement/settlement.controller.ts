import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { BetStatus } from '@prisma/client';

@Controller('settlement')
@UseGuards(JwtAuthGuard)
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  /**
   * Get pending bets for the current user
   * GET /settlement/bets/me/pending
   */
  @Get('bets/me/pending')
  async getMyPendingBets(@CurrentUser() user: User) {
    return this.settlementService.getUserPendingBets(user.id);
  }

  /**
   * Get settled bets for the current user
   * GET /settlement/bets/me/settled
   */
  @Get('bets/me/settled')
  async getMySettledBets(
    @CurrentUser() user: User,
    @Query('status') status?: 'WON' | 'LOST' | 'CANCELLED',
  ) {
    return this.settlementService.getUserSettledBets(user.id, status);
  }

  /**
   * Get all bets for the current user (with optional status filter)
   * GET /settlement/bets/me?status=PENDING
   */
  @Get('bets/me')
  async getMyBets(
    @CurrentUser() user: User,
    @Query('status') status?: BetStatus,
  ) {
    return this.settlementService.getUserBets(user.id, status);
  }
}
