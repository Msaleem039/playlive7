// transfer.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  Logger,
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
  private readonly logger = new Logger(BalanceTransferController.name);
  
  constructor(private readonly transferService: TransferService) {}

  // 🔼 Top-up endpoint
  @Post('top-up/:targetUserId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async topUpBalance(
    @Param('targetUserId') targetUserId: string,
    @Body() dto: BalanceChangeDto,
    @CurrentUser() currentUser: User,
  ) {
    try {
      return await this.transferService.topUpBalance(currentUser, targetUserId, dto);
    } catch (error) {
      this.logger.error(`Error in topUpBalance endpoint: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // Re-throw to let NestJS handle the response
    }
  }

  // 🔽 Top-down (withdraw) endpoint
  @Post('top-down/:targetUserId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
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
  @Roles(UserRole.AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getDashboardSummary(@CurrentUser() currentUser: User) {
    return this.transferService.getDashboardSummary(currentUser);
  }
}

