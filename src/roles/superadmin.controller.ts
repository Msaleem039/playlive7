import { 
  Controller, 
  Get, 
  Post, 
  Put, 
  Body, 
  Param, 
  Query,
  UseGuards,
  ValidationPipe,
  ParseIntPipe
} from '@nestjs/common';
import { IsString, IsEmail, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { TransferService } from '../transfer/transfer.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

// Removed role-specific CreateAdminDto in favor of unified /auth/create-user

export class UpdateCommissionDto {
  userId: string;
  commissionPercentage: number;
}

@Controller('superadmin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SuperAdminController {
  constructor(
    private readonly transferService: TransferService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService
  ) {}

  /**
   * Get all users in the system
   */
  @Get('users')
  async getAllUsers() {
    return this.usersService.getAllUsers();
  }

  /**
   * Get all admins (direct children)
   */
  @Get('admins')
  async getAdmins(@CurrentUser() currentUser: User) {
    return this.transferService.getUserChildren(currentUser.id);
  }

  // Removed deprecated create-admin endpoint. Use POST /auth/create-user

  /**
   * Get system-wide transfer statistics
   */
  @Get('statistics')
  async getSystemStatistics() {
    return {
      message: 'SuperAdmin system statistics',
      features: [
        'Total transfers count',
        'Total commission earned',
        'User hierarchy overview',
        'Balance distribution'
      ]
    };
  }

  /**
   * Get all transfer transactions
   */
  @Get('transfers')
  async getAllTransfers(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return {
      message: 'All transfers endpoint',
      limit: limit || 100,
      note: 'Implement getAllTransfers method in TransferService'
    };
  }

  /**
   * Update any user's commission percentage
   */
  @Put('commission')
  async updateCommission(
    @Body(ValidationPipe) updateCommissionDto: UpdateCommissionDto
  ) {
    const { userId, commissionPercentage } = updateCommissionDto;
    
    // SuperAdmin can update any user's commission
    return this.usersService.updateCommission(userId, commissionPercentage);
  }

  /**
   * Get user hierarchy tree by user ID
   */
  @Get('hierarchy/:userId')
  async getUserHierarchy(@Param('userId') userId: string) {
    return this.transferService.getHierarchyTree(userId);
  }

  /**
   * Get user balance by user ID
   */
  @Get('balance/:userId')
  async getUserBalance(@Param('userId') userId: string) {
    return this.transferService.getUserBalance(userId);
  }

  /**
   * Get user transfer history by user ID
   */
  @Get('history/:userId')
  async getUserTransferHistory(
    @Param('userId') userId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.transferService.getTransferHistory(userId, limit);
  }

  /**
   * Transfer funds to any user (SuperAdmin privilege)
   */
  @Post('transfer')
  async transferToAnyUser(
    @Body() transferDto: { fromUserId: string; toUserId: string; amount: number },
    @CurrentUser() currentUser: User
  ) {
    // SuperAdmin can transfer from any user to any user
    return this.transferService.transferFunds(transferDto.fromUserId, {
      toUserId: transferDto.toUserId,
      amount: transferDto.amount
    });
  }

  /**
   * Get system overview
   */
  @Get('overview')
  async getSystemOverview() {
    return {
      message: 'SuperAdmin system overview',
      features: [
        'Total users count',
        'Total balance in system',
        'Active transfers today',
        'Commission earned today',
        'User distribution by role'
      ]
    };
  }
}