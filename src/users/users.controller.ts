import { Controller, Get, UseGuards, Patch, Body, Param, ParseEnumPipe, NotFoundException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { UserResponseDto } from '../auth/dto/auth-response.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getCurrentUser(@CurrentUser() user: User): Promise<UserResponseDto> {
    return this.usersService.getCurrentUser(user.id);
  }

  @Get('me/wallet')
  async getMyWalletBalance(@CurrentUser() user: User) {
    return this.usersService.getWalletBalanceWithLiability(user.id);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getAllUsers(): Promise<UserResponseDto[]> {
    return this.usersService.getAllUsers();
  }

  @Get(':id/wallet')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getUserWalletBalance(
    @Param('id') id: string,
    @CurrentUser() currentUser: User,
  ) {
    // Verify access permissions
    if (currentUser.role === UserRole.AGENT) {
      const user = await this.usersService.getUserDetail(id);
      if (!user || user.parentId !== currentUser.id) {
        throw new ForbiddenException('You do not have access to this user');
      }
    }

    if (currentUser.role === UserRole.ADMIN) {
      const user = await this.usersService.getUserDetail(id);
      if (!user || user.role === UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('You do not have access to this user');
      }
    }

    return this.usersService.getWalletBalanceWithLiability(id);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getUserById(
    @Param('id') id: string,
    @CurrentUser() currentUser: User,
  ) {
    const user = await this.usersService.getUserDetail(id);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (currentUser.role === UserRole.AGENT && user.parentId !== currentUser.id) {
      throw new ForbiddenException('You do not have access to this user');
    }

    if (currentUser.role === UserRole.ADMIN && user.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('You do not have access to this user');
    }

    return user;
  }

  @Patch(':id/role')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async updateUserRole(
    @Param('id') id: string,
    @Body('role', new ParseEnumPipe(UserRole)) role: UserRole,
  ): Promise<UserResponseDto> {
    const updatedUser = await this.usersService.updateRole(id, role);
    return {
      id: updatedUser.id,
      name: updatedUser.name,
      username: updatedUser.username,
      role: updatedUser.role,
      balance: updatedUser.balance,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt,
    };
  }
}
