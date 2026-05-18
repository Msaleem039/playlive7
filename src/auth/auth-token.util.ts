import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { JwtPayload } from './types/jwt-payload.interface';

export type AccessTokenUserInput = {
  id: string;
  username: string;
  role: UserRole;
  name: string;
  isActive: boolean;
  impersonatedBy?: string;
};

export function buildJwtPayload(user: AccessTokenUserInput): JwtPayload {
  return {
    sub: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    isActive: user.isActive,
    ...(user.impersonatedBy ? { impersonatedBy: user.impersonatedBy } : {}),
  };
}

export function signAccessToken(
  jwtService: JwtService,
  user: AccessTokenUserInput,
): string {
  return jwtService.sign(buildJwtPayload(user));
}
