import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Get required roles from method-level first, then class-level
    const handlerRoles = this.reflector.get<UserRole[]>(ROLES_KEY, context.getHandler());
    const classRoles = this.reflector.get<UserRole[]>(ROLES_KEY, context.getClass());
    
    // Method-level roles take precedence over class-level
    const requiredRoles = handlerRoles || classRoles;

    // If no roles are required, deny access by default (secure by default)
    if (!requiredRoles || requiredRoles.length === 0) {
      return false;
    }

    const { user } = context.switchToHttp().getRequest();
    
    if (!user) {
      return false;
    }

    // Check if user's role matches one of the required roles
    return requiredRoles.some((role) => user.role === role);
  }
}
