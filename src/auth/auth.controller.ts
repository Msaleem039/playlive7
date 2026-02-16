import { Controller, Get, Post, Body, HttpCode, HttpStatus, ValidationPipe, UseGuards, Patch, BadRequestException, Param, Query, ParseIntPipe } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body(ValidationPipe) body: any): Promise<AuthResponseDto> {
    // Support both "email" and "username" fields for login
    const loginDto: LoginDto = {
      username: body.username || body.email,
      password: body.password,
    };
    
    if (!loginDto.username) {
      throw new BadRequestException('Either "username" or "email" field is required');
    }
    
    return this.authService.login(loginDto);
  }

  /**
   * ✅ UNIFIED USER CREATION ENDPOINT
   * Creates users with any role based on creator's permissions
   * 
   * ⚠️ SPECIAL: Can create first SUPER_ADMIN without authentication
   * After first super admin exists, authentication required for all user creation
   * 
   * Role Hierarchy:
   * - SUPER_ADMIN: can create ADMIN, AGENT, CLIENT
   * - ADMIN: can create AGENT, CLIENT  
   * - AGENT: can create CLIENT
   * - CLIENT: cannot create users
   * 
   * @example Create First Super Admin: { "name": "azhar", "email": "azhar@gmail.com", "password": "azhar12", "role": "SUPER_ADMIN" }
   * @example Create Admin: { "name": "John", "username": "johnadmin", "password": "Secret123!", "role": "ADMIN", "commissionPercentage": 15 }
   * @example Create Agent: { "name": "Jane", "username": "janeagent", "password": "Secret123!", "role": "AGENT", "commissionPercentage": 20 }
   * @example Create Client: { "name": "Bob", "username": "bobclient", "password": "Secret123!", "role": "CLIENT" }
   */
  @Post('create-user')
  @UseGuards(OptionalJwtAuthGuard)
  async createUser(
    @Body(ValidationPipe) body: CreateUserDto,
    @CurrentUser() currentUser?: User,
  ): Promise<AuthResponseDto> {
    // Auto-generate username from name or email if not provided
    if (!body.username) {
      let generatedUsername: string;
      
      if (body.email) {
        // Use email prefix (before @) as username
        generatedUsername = body.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_');
      } else if (body.name) {
        // Generate username from name: lowercase, replace spaces with underscores, remove special chars
        generatedUsername = body.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '_');
      } else {
        throw new BadRequestException('Either username, name, or email field is required');
      }
      
      // Ensure username meets length requirements (3-30 characters)
      // Remove leading/trailing underscores and collapse multiple underscores
      generatedUsername = generatedUsername.replace(/^_+|_+$/g, '').replace(/_+/g, '_');
      
      // If too short, pad with numbers; if too long, truncate
      if (generatedUsername.length < 3) {
        generatedUsername = generatedUsername.padEnd(3, '0');
      } else if (generatedUsername.length > 30) {
        generatedUsername = generatedUsername.substring(0, 30);
      }
      
      // Fallback if still empty or invalid
      if (!generatedUsername || generatedUsername.length < 3) {
        generatedUsername = 'user_' + Date.now().toString().slice(-6);
      }
      
      body.username = generatedUsername;
    }
    
    return this.authService.createUser(body, currentUser || null);
  }

  /**
   * Change own password
   * Users can only change their own password by providing their current password
   * 
   * @example PATCH /auth/change-password
   * Body: { "currentPassword": "oldpassword123", "newPassword": "newpassword456" }
   */
  @Patch('update-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser() currentUser: User,
    @Body(ValidationPipe) changePasswordDto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(currentUser, changePasswordDto);
  }

  /**
   * Get available user roles and hierarchy information
   */
  @Get('roles-info')
  getRolesInfo() {
    return {
      message: 'User roles and creation hierarchy',
      hierarchy: {
        SUPER_ADMIN: {
          canCreate: ['ADMIN', 'AGENT', 'CLIENT', 'SETTLEMENT_ADMIN'],
          description: 'System administrator with full access'
        },
        ADMIN: {
          canCreate: ['AGENT', 'CLIENT'],
          description: 'Administrator managing agents and clients'
        },
        AGENT: {
          canCreate: ['CLIENT'],
          description: 'Agent managing clients'
        },
        CLIENT: {
          canCreate: [],
          description: 'End user/client'
        },
        SETTLEMENT_ADMIN: {
          canCreate: [],
          description: 'Settlement administrator - can only settle markets, no wallet, cannot create users'
        }
      },
      unifiedEndpoint: {
        url: 'POST /auth/create-user',
        description: 'Single endpoint to create users with any role',
        requiredFields: ['name', 'username', 'password', 'role'],
        optionalFields: ['email', 'commissionPercentage', 'balance', 'initialBalance']
      },
      deprecatedEndpoints: [
        'POST /superadmin/create-admin (use POST /auth/create-user with role: "ADMIN")',
        'POST /admin/create-agent (use POST /auth/create-user with role: "AGENT")'
      ]
    };
  }
  
  /**
   * ✅ GET /auth/subordinates
   * 
   * Get subordinates with optional account statement details.
   * 
   * Query Parameters:
   * - parentId (optional): Get children of specific parent (default: current user)
   * - type (optional): 
   *   - "bets": Return bet history for a specific client (requires parentId)
   *   - "statement": Return account statement for subordinates
   * - showCashEntry (optional, default: true): Show CashIn/CashOut in statement
   * - showMarketPnl (optional, default: true): Show Market Profit & Loss in statement
   * - showMarketCommission (optional, default: false): Show Market Commission in statement
   * - showSessionPnl (optional, default: false): Show Session Profit & Loss in statement
   * - showTossPnl (optional, default: false): Show Toss Profit & Loss in statement
   * - fromDate (optional): Filter statement from date (ISO string)
   * - toDate (optional): Filter statement to date (ISO string)
   * - limit (optional, default: 1000): Maximum statement entries per user
   * - offset (optional, default: 0): Pagination offset for statement
   * 
   * Examples:
   * - GET /auth/subordinates (returns list of subordinates)
   * - GET /auth/subordinates?type=statement (returns subordinates with account statements)
   * - GET /auth/subordinates?type=statement&showCashEntry=true&showMarketPnl=true
   * - GET /auth/subordinates?parentId=xxx&type=bets (returns bet history for specific client)
   */
  @Get('subordinates')
  @UseGuards(JwtAuthGuard)
  async getSubordinates(
    @CurrentUser() currentUser: User,
    @Query('parentId') parentId?: string,
    @Query('type') type?: string,
    @Query('showCashEntry') showCashEntry?: string,
    @Query('showMarketPnl') showMarketPnl?: string,
    @Query('showMarketCommission') showMarketCommission?: string,
    @Query('showSessionPnl') showSessionPnl?: string,
    @Query('showTossPnl') showTossPnl?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
    @Query('betLimit', new ParseIntPipe({ optional: true })) betLimit?: number,
    @Query('betOffset', new ParseIntPipe({ optional: true })) betOffset?: number,
    @Query('betStatus') betStatus?: string,
    @Query('betStartDate') betStartDate?: string,
    @Query('betEndDate') betEndDate?: string,
  ) {
    return this.authService.getSubordinates(
      currentUser,
      parentId,
      type,
      {
        showCashEntry: showCashEntry !== 'false',
        showMarketPnl: showMarketPnl !== 'false',
        showMarketCommission: showMarketCommission === 'true',
        showSessionPnl: showSessionPnl === 'true',
        showTossPnl: showTossPnl === 'true',
        fromDate: fromDate ? new Date(fromDate) : undefined,
        toDate: toDate ? new Date(toDate) : undefined,
        limit: limit || 1000,
        offset: offset || 0,
        betLimit: betLimit || 20,
        betOffset: betOffset || 0,
        betStatus: betStatus,
        betStartDate: betStartDate ? new Date(betStartDate) : undefined,
        betEndDate: betEndDate ? new Date(betEndDate) : undefined,
      },
    );
  }

  /**
   * Toggle user active/inactive status
   * Only parents can change status of their direct subordinates
   * 
   * @example PATCH /auth/toggle-user-status/:userId
   * Body: { "isActive": false }
   */
  @Patch('toggle-user-status/:targetUserId')
  @UseGuards(JwtAuthGuard)
  async toggleUserStatus(
    @Param('targetUserId') targetUserId: string,
    @Body() body: { isActive: boolean },
    @CurrentUser() currentUser: User,
  ) {
    return this.authService.toggleUserStatus(currentUser, targetUserId, body.isActive);
  }

  /**
   * Update client details (Agent only)
   * Allows agents to update their client's name, password, commission, and maxWinLimit
   * Username cannot be changed
   * 
   * @example PATCH /auth/subordinates/:clientId
   * Body: { "name": "New Name", "password": "newpassword123", "commissionPercentage": 5, "maxWinLimit": 100000 }
   */
  @Patch('subordinates/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateClient(
    @Param('clientId') clientId: string,
    @Body(ValidationPipe) updateClientDto: UpdateClientDto,
    @CurrentUser() currentUser: User,
  ) {
    return this.authService.updateClient(currentUser, clientId, updateClientDto);
  }
}


