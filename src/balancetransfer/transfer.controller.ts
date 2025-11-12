// transfer.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TransferService } from './transfer.service';
import { BalanceChangeDto } from './dto/balance-change.dto';
import type { User } from '@prisma/client';

@Controller('transfer')
@UseGuards(JwtAuthGuard)
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

  // 📊 Dashboard summary endpoint
  @Get('dashboard-summary')
  async getDashboardSummary(@CurrentUser() currentUser: User) {
    return this.transferService.getDashboardSummary(currentUser);
  }
}

