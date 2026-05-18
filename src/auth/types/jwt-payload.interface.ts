import { UserRole } from '@prisma/client';

/** Claims stored in the signed JWT access token. */
export interface JwtPayload {
  sub: string;
  username: string;
  role: UserRole;
  name: string;
  /** Omitted on legacy tokens — treated as active until expiry. */
  isActive?: boolean;
  impersonatedBy?: string;
  iat?: number;
  exp?: number;
}

/**
 * User attached to `request.user` after JWT validation.
 * Built from the token only — no database round-trip.
 */
export interface JwtAuthUser {
  id: string;
  username: string;
  role: UserRole;
  name: string;
  isActive: boolean;
  impersonatedBy?: string;
}
