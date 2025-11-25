// transfer.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TransferService } from './transfer.service';
import { BalanceChangeDto } from './dto/balance-change.dto';
import type { User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@Controller('transfer')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BalanceTransferController {
  constructor(private readonly transferService: TransferService) {}

  // 🔼 Top-up endpoint
  @Post('top-up/:targetUserId')
  async topUpBalance(
    @Param('targetUserId') targetUserId: string,
    @Body() dto: BalanceChangeDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.transferService.topUpBalance(currentUser, targetUserId, dto);
  }

  // 🔽 Top-down (withdraw) endpoint
  @Post('top-down/:targetUserId')
  async topDownBalance(
    @Param('targetUserId') targetUserId: string,
    @Body() dto: BalanceChangeDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.transferService.topDownBalance(currentUser, targetUserId, dto);
  }

  // 🔼 SuperAdmin self top-up endpoint
  @Post('superadmin/self-topup')
  @Roles(UserRole.SUPER_ADMIN)
  async superAdminSelfTopUp(
    @Body() dto: BalanceChangeDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.transferService.topUpBalance(currentUser, currentUser.id, dto);
  }

  // 📊 Dashboard summary endpoint
  @Get('dashboard-summary')
  async getDashboardSummary(@CurrentUser() currentUser: User) {
    return this.transferService.getDashboardSummary(currentUser);
  }
}

