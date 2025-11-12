import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { UserRole } from '@prisma/client';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  @Get('dashboard')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  getAdminDashboard(@CurrentUser() user: User) {
    return {
      message: `Welcome to admin dashboard, ${user.name}!`,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('super-admin-only')
  @Roles(UserRole.SUPER_ADMIN)
  getSuperAdminOnly(@CurrentUser() user: User) {
    return {
      message: `This is a super admin only endpoint, ${user.name}!`,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
