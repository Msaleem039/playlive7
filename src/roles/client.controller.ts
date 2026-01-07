import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Query,
  UseGuards,
  ValidationPipe,
  ParseIntPipe
} from '@nestjs/common';
import { TransferService } from '../transfer/transfer.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole, TransferLogType } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('client')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT)
export class ClientController {
  constructor(
    private readonly transferService: TransferService,
    private readonly usersService: UsersService
  ) {}

  /**
   * Get client's balance
   */
  @Get('balance')
  async getBalance(@CurrentUser() currentUser: User) {
    return this.transferService.getUserBalance(currentUser.id);
  }

  /**
   * Get client's transfer history
   */
  @Get('transfers')
  async getTransferHistory(
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.transferService.getTransferHistory(currentUser.id, limit);
  }

  /**
   * Get client's profile
   */
  @Get('profile')
  async getProfile(@CurrentUser() currentUser: User) {
    return this.usersService.getCurrentUser(currentUser.id);
  }

  /**
   * Get client's parent (agent) information
   */
  @Get('agent')
  async getAgentInfo(@CurrentUser() currentUser: User) {
    const user = await this.usersService.findById(currentUser.id);
    if (!user?.parentId) {
      return { message: 'No parent agent assigned' };
    }
    
    return this.usersService.findById(user.parentId);
  }

  /**
   * Get client's commission percentage
   */
  @Get('commission')
  async getCommissionPercentage(@CurrentUser() currentUser: User) {
    const user = await this.usersService.findById(currentUser.id);
    return {
      commissionPercentage: user?.commissionPercentage || 100,
      message: 'This is the percentage you receive when funds are transferred to you'
    };
  }

  /**
   * Get client's hierarchy (shows parent chain)
   */
  @Get('hierarchy')
  async getHierarchy(@CurrentUser() currentUser: User) {
    return this.transferService.getHierarchyTree(currentUser.id);
  }

  /**
   * Get client's statistics
   */
  @Get('statistics')
  async getClientStatistics(@CurrentUser() currentUser: User) {
    const balance = await this.transferService.getUserBalance(currentUser.id);
    const transfers = await this.transferService.getTransferHistory(currentUser.id, 10);
    
    return {
      message: 'Client statistics',
      clientId: currentUser.id,
      currentBalance: balance.balance,
      recentTransfers: transfers.length,
      features: [
        'Current balance',
        'Total transfers received',
        'Recent transfer history',
        'Commission percentage'
      ]
    };
  }

  /**
   * Get client's overview
   */
  @Get('overview')
  async getClientOverview(@CurrentUser() currentUser: User) {
    const balance = await this.transferService.getUserBalance(currentUser.id);
    const transfers = await this.transferService.getTransferHistory(currentUser.id, 5);
    const agent = await this.getAgentInfo(currentUser);
    
    return {
      message: 'Client overview',
      clientId: currentUser.id,
      currentBalance: balance.balance,
      recentTransfers: transfers.length,
      agent: agent,
      features: [
        'Current balance',
        'Recent transfers',
        'Agent information',
        'Commission details'
      ]
    };
  }

  /**
   * Get client's account statement
   * GET /client/account-statement
   * 
   * Query Parameters:
   * - fromDate (optional): Filter from date (ISO string, e.g., "2024-01-01T00:00:00.000Z")
   * - toDate (optional): Filter to date (ISO string, e.g., "2024-01-31T23:59:59.999Z")
   * - type (optional): Filter by transfer type (TOPUP, TOPDOWN, or ALL)
   * - limit (optional): Number of results per page (default: 20)
   * - offset (optional): Pagination offset (default: 0)
   * 
   * Examples:
   * - GET /client/account-statement
   * - GET /client/account-statement?fromDate=2024-01-01T00:00:00.000Z&toDate=2024-01-31T23:59:59.999Z
   * - GET /client/account-statement?type=TOPUP&limit=10
   * - GET /client/account-statement?fromDate=2024-01-01T00:00:00.000Z&toDate=2024-01-31T23:59:59.999Z&limit=20&offset=0
   */
  @Get('account-statement')
  async getAccountStatement(
    @CurrentUser() currentUser: User,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('type') type?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    // Parse dates
    const fromDateObj = fromDate ? new Date(fromDate) : undefined;
    const toDateObj = toDate ? new Date(toDate) : undefined;

    // Validate transfer type
    let transferType: TransferLogType | 'ALL' = 'ALL';
    if (type && type !== 'ALL') {
      const validTypes = Object.values(TransferLogType);
      if (validTypes.includes(type as TransferLogType)) {
        transferType = type as TransferLogType;
      }
    }

    // Set defaults
    const limitValue = limit || 20;
    const offsetValue = offset || 0;

    return this.transferService.getAccountStatement(currentUser.id, {
      fromDate: fromDateObj,
      toDate: toDateObj,
      type: transferType,
      limit: limitValue,
      offset: offsetValue,
    });
  }
}
