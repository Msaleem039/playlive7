import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

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
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
export class SettlementAdminController {
  constructor(private readonly settlementService: SettlementService) {}

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
}

