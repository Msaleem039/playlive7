import { Controller, Get, Post, Body, HttpCode, HttpStatus, ValidationPipe, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import type { User } from '@prisma/client';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body(ValidationPipe) registerDto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body(ValidationPipe) loginDto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(loginDto);
  }

  /**
   * ✅ UNIFIED USER CREATION ENDPOINT
   * Creates users with any role based on creator's permissions
   * 
   * Role Hierarchy:
   * - SUPER_ADMIN: can create ADMIN, AGENT, CLIENT
   * - ADMIN: can create AGENT, CLIENT  
   * - AGENT: can create CLIENT
   * - CLIENT: cannot create users
   * 
   * @example Create Admin: { "name": "John", "email": "john@example.com", "password": "Secret123!", "role": "ADMIN", "commissionPercentage": 15 }
   * @example Create Agent: { "name": "Jane", "email": "jane@example.com", "password": "Secret123!", "role": "AGENT", "commissionPercentage": 20 }
   * @example Create Client: { "name": "Bob", "email": "bob@example.com", "password": "Secret123!", "role": "CLIENT" }
   */
  @Post('create-user')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async createUser(
    @Body(ValidationPipe) createUserDto: CreateUserDto,
    @CurrentUser() currentUser: User,
  ): Promise<AuthResponseDto> {
    return this.authService.createUser(createUserDto, currentUser);
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
        requiredFields: ['name', 'email', 'password', 'role'],
        optionalFields: ['balance', 'commissionPercentage']
      },
      deprecatedEndpoints: [
        'POST /superadmin/create-admin (use POST /auth/create-user with role: "ADMIN")',
        'POST /admin/create-agent (use POST /auth/create-user with role: "AGENT")'
      ]
    };
  }

  /**
   * Create initial SuperAdmin (public endpoint for setup)
   * Only works if no SuperAdmin exists in the system
   */
  @Post('create-superadmin')
  async createSuperAdmin(@Body(ValidationPipe) createUserDto: CreateUserDto): Promise<AuthResponseDto> {
    return this.authService.createSuperAdmin(createUserDto);
  }

  /**
   * Create additional SuperAdmin (requires existing SuperAdmin)
   */
  @Post('create-additional-superadmin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async createAdditionalSuperAdmin(
    @Body(ValidationPipe) createUserDto: CreateUserDto,
    @CurrentUser() currentUser: User,
  ): Promise<AuthResponseDto> {
    return this.authService.createUser(createUserDto, currentUser);
  }
}
