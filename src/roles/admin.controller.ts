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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

// Removed role-specific CreateAgentDto in favor of unified /auth/create-user

export class UpdateAgentCommissionDto {
  agentId: string;
  commissionPercentage: number;
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly transferService: TransferService,
    private readonly usersService: UsersService
  ) {}

  /**
   * Get all agents (direct children)
   */
  @Get('agents')
  async getAgents(@CurrentUser() currentUser: User) {
    return this.transferService.getUserChildren(currentUser.id);
  }

  // Removed deprecated create-agent endpoint. Use POST /auth/create-user

  /**
   * Get admin's transfer statistics
   */
  @Get('statistics')
  async getAdminStatistics(@CurrentUser() currentUser: User) {
    return {
      message: 'Admin statistics',
      adminId: currentUser.id,
      features: [
        'Total agents under admin',
        'Total transfers to agents',
        'Commission earned from agents',
        'Agent performance metrics'
      ]
    };
  }

  /**
   * Get transfers to agents
   */
  @Get('transfers')
  async getTransfersToAgents(
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.transferService.getTransferHistory(currentUser.id, limit);
  }

  /**
   * Update agent's commission percentage
   */
  @Put('agent-commission')
  async updateAgentCommission(
    @Body(ValidationPipe) updateCommissionDto: UpdateAgentCommissionDto,
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.updateCommissionPercentage(
      currentUser.id,
      updateCommissionDto.agentId,
      updateCommissionDto.commissionPercentage
    );
  }

  /**
   * Get agent hierarchy tree
   */
  @Get('agent-hierarchy/:agentId')
  async getAgentHierarchy(
    @Param('agentId') agentId: string,
    @CurrentUser() currentUser: User
  ) {
    // Verify the agent is under this admin
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyAgent = children.some(child => child.id === agentId);
    
    if (!isMyAgent) {
      throw new Error('Agent not found under this admin');
    }
    
    return this.transferService.getHierarchyTree(agentId);
  }

  /**
   * Get agent balance
   */
  @Get('agent-balance/:agentId')
  async getAgentBalance(
    @Param('agentId') agentId: string,
    @CurrentUser() currentUser: User
  ) {
    // Verify the agent is under this admin
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyAgent = children.some(child => child.id === agentId);
    
    if (!isMyAgent) {
      throw new Error('Agent not found under this admin');
    }
    
    return this.transferService.getUserBalance(agentId);
  }

  /**
   * Get agent transfer history
   */
  @Get('agent-history/:agentId')
  async getAgentTransferHistory(
    @Param('agentId') agentId: string,
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    // Verify the agent is under this admin
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyAgent = children.some(child => child.id === agentId);
    
    if (!isMyAgent) {
      throw new Error('Agent not found under this admin');
    }
    
    return this.transferService.getTransferHistory(agentId, limit);
  }

  /**
   * Transfer funds to agent
   */
  @Post('transfer-to-agent')
  async transferToAgent(
    @Body() transferDto: { agentId: string; amount: number },
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.transferFunds(currentUser.id, {
      toUserId: transferDto.agentId,
      amount: transferDto.amount
    });
  }

  /**
   * Get admin overview
   */
  @Get('overview')
  async getAdminOverview(@CurrentUser() currentUser: User) {
    const children = await this.transferService.getUserChildren(currentUser.id);
    
    return {
      message: 'Admin overview',
      adminId: currentUser.id,
      totalAgents: children.length,
      features: [
        'Total agents under admin',
        'Total balance transferred to agents',
        'Commission earned from agents',
        'Agent performance summary'
      ]
    };
  }
}
