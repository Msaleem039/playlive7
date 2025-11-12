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
import { IsString, IsOptional, IsNumber, Min, Max, MinLength, MaxLength } from 'class-validator';
import { TransferService } from '../transfer/transfer.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

export class CreateClientDto {
  @IsString()
  name: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username: string;

  @IsString()
  password: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;
}

export class UpdateClientCommissionDto {
  clientId: string;
  commissionPercentage: number;
}

@Controller('agent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.AGENT)
export class AgentController {
  constructor(
    private readonly transferService: TransferService,
    private readonly usersService: UsersService
  ) {}

  /**
   * Get all clients (direct children)
   */
  @Get('clients')
  async getClients(@CurrentUser() currentUser: User) {
    return this.transferService.getUserChildren(currentUser.id);
  }

  /**
   * Create a new client
   */
  @Post('create-client')
  async createClient(
    @Body(ValidationPipe) createClientDto: CreateClientDto,
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.createUserWithHierarchy(currentUser.id, {
      name: createClientDto.name,
      username: createClientDto.username,
      password: createClientDto.password,
      role: UserRole.CLIENT,
      commissionPercentage: createClientDto.commissionPercentage
    });
  }

  /**
   * Get agent's transfer statistics
   */
  @Get('statistics')
  async getAgentStatistics(@CurrentUser() currentUser: User) {
    return {
      message: 'Agent statistics',
      agentId: currentUser.id,
      features: [
        'Total clients under agent',
        'Total transfers to clients',
        'Commission earned from clients',
        'Client performance metrics'
      ]
    };
  }

  /**
   * Get transfers to clients
   */
  @Get('transfers')
  async getTransfersToClients(
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    return this.transferService.getTransferHistory(currentUser.id, limit);
  }

  /**
   * Update client's commission percentage
   */
  @Put('client-commission')
  async updateClientCommission(
    @Body(ValidationPipe) updateCommissionDto: UpdateClientCommissionDto,
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.updateCommissionPercentage(
      currentUser.id,
      updateCommissionDto.clientId,
      updateCommissionDto.commissionPercentage
    );
  }

  /**
   * Get client details
   */
  @Get('client/:clientId')
  async getClientDetails(
    @Param('clientId') clientId: string,
    @CurrentUser() currentUser: User
  ) {
    // Verify the client is under this agent
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyClient = children.some(child => child.id === clientId);
    
    if (!isMyClient) {
      throw new Error('Client not found under this agent');
    }
    
    return this.usersService.findById(clientId);
  }

  /**
   * Get client balance
   */
  @Get('client-balance/:clientId')
  async getClientBalance(
    @Param('clientId') clientId: string,
    @CurrentUser() currentUser: User
  ) {
    // Verify the client is under this agent
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyClient = children.some(child => child.id === clientId);
    
    if (!isMyClient) {
      throw new Error('Client not found under this agent');
    }
    
    return this.transferService.getUserBalance(clientId);
  }

  /**
   * Get client transfer history
   */
  @Get('client-history/:clientId')
  async getClientTransferHistory(
    @Param('clientId') clientId: string,
    @CurrentUser() currentUser: User,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ) {
    // Verify the client is under this agent
    const children = await this.transferService.getUserChildren(currentUser.id);
    const isMyClient = children.some(child => child.id === clientId);
    
    if (!isMyClient) {
      throw new Error('Client not found under this agent');
    }
    
    return this.transferService.getTransferHistory(clientId, limit);
  }

  /**
   * Transfer funds to client
   */
  @Post('transfer-to-client')
  async transferToClient(
    @Body() transferDto: { clientId: string; amount: number },
    @CurrentUser() currentUser: User
  ) {
    return this.transferService.transferFunds(currentUser.id, {
      toUserId: transferDto.clientId,
      amount: transferDto.amount
    });
  }

  /**
   * Get agent overview
   */
  @Get('overview')
  async getAgentOverview(@CurrentUser() currentUser: User) {
    const children = await this.transferService.getUserChildren(currentUser.id);
    
    return {
      message: 'Agent overview',
      agentId: currentUser.id,
      totalClients: children.length,
      features: [
        'Total clients under agent',
        'Total balance transferred to clients',
        'Commission earned from clients',
        'Client performance summary'
      ]
    };
  }
}
