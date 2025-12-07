import { Controller, Get, Post, Body, HttpCode, HttpStatus, ValidationPipe, UseGuards, Patch, BadRequestException, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
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
    // Username is required, email is optional
    if (!body.username) {
      throw new BadRequestException('Username field is required');
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
          canCreate: ['ADMIN', 'AGENT', 'CLIENT'],
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
  
  @Get('subordinates')
  @UseGuards(JwtAuthGuard)
  async getSubordinates(@CurrentUser() currentUser: User) {
    return this.authService.getSubordinates(currentUser.id);
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
}


