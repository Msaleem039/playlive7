import { 
  Controller, 
  Post, 
  Get, 
  Body, 
  Param, 
  UseGuards, 
  Query,
  ParseIntPipe,
  ValidationPipe 
} from '@nestjs/common';
import { TransferService, type TransferDto } from './transfer.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

export class TransferFundsDto {
  toUserId: string;
  amount: number;
}

export class UpdateCommissionDto {
  childId: string;
  commissionPercentage: number;
}

@Controller('transfer')
@UseGuards(JwtAuthGuard)
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  /**
   * Transfer funds from current user to their child
   */
  @Post()
  async transferFunds(
    @Body(ValidationPipe) transferDto: TransferDto,
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.transferFunds(currentUser.id, transferDto);
  }

  /**
   * Get current user's balance
   */
  @Get('balance')
  async getBalance(@CurrentUser() currentUser: User) {
    return this.transferService.getUserBalance(currentUser.id);
  }

  /**
   * Get current user's children
   */
  @Get('children')
  async getChildren(@CurrentUser() currentUser: User) {
    return this.transferService.getUserChildren(currentUser.id);
  }

  /**
   * Get transfer history for current user
   */
  @Get('history')
  async getTransferHistory(
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.transferService.getTransferHistory(currentUser.id, limit);
  }

  /**
   * Get hierarchy tree for current user
   */
  @Get('hierarchy')
  async getHierarchy(@CurrentUser() currentUser: User) {
    return this.transferService.getHierarchyTree(currentUser.id);
  }

  /**
   * Update commission percentage for a child (only by parent)
   */
  @Post('commission')
  async updateCommission(
    @Body(ValidationPipe) updateCommissionDto: UpdateCommissionDto,
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.updateCommissionPercentage(
      currentUser.id,
      updateCommissionDto.childId,
      updateCommissionDto.commissionPercentage
    );
  }

  /**
   * Admin endpoint: Get all transfers (Super Admin and Admin only)
   */
  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getAllTransfers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    // This would require a new method in TransferService to get all transfers
    // For now, return a placeholder
    return {
      message: 'Admin endpoint - implement getAllTransfers method in TransferService',
      limit: limit || 50
    };
  }

  /**
   * Admin endpoint: Get user balance by ID (Super Admin and Admin only)
   */
  @Get('admin/balance/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getAdminUserBalance(@Param('userId') userId: string) {
    return this.transferService.getUserBalance(userId);
  }

  /**
   * Admin endpoint: Get user hierarchy by ID (Super Admin and Admin only)
   */
  @Get('admin/hierarchy/:userId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getAdminUserHierarchy(@Param('userId') userId: string) {
    return this.transferService.getHierarchyTree(userId);
  }
}
