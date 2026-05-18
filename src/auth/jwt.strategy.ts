import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { JwtAuthUser, JwtPayload } from './types/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(configService: ConfigService) {
    const jwtSecret = configService.get<string>('JWT_SECRET');

    if (!jwtSecret) {
      const errorMsg = 'JWT_SECRET is not set in environment variables';
      Logger.error(errorMsg, 'JwtStrategy');
      throw new Error(errorMsg);
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  /**
   * Stateless validation: trust signed JWT claims only (no DB query).
   * Security: disabled users are rejected; role/isActive changes apply after re-login or token expiry.
   * placeBet and other sensitive paths still re-check isActive/bettingEnabled in the database.
   */
  validate(payload: JwtPayload): JwtAuthUser {
    if (!payload?.sub) {
      this.logger.warn('JWT payload missing required field: sub');
      throw new UnauthorizedException('Invalid token: missing user identifier');
    }

    if (payload.exp && payload.exp * 1000 < Date.now()) {
      this.logger.warn(
        `JWT token expired for user ${payload.sub} (exp: ${new Date(payload.exp * 1000).toISOString()})`,
      );
      throw new UnauthorizedException('Token expired');
    }

    const username = String(payload.username || '').trim();
    if (!username) {
      throw new UnauthorizedException('Invalid token: missing username');
    }

    const role = payload.role;
    if (!role || !Object.values(UserRole).includes(role)) {
      throw new UnauthorizedException('Invalid token: missing or invalid role');
    }

    // Explicit false only — legacy tokens without isActive still work until they expire
    if (payload.isActive === false) {
      this.logger.warn(`JWT rejected: inactive user ${payload.sub}`);
      throw new UnauthorizedException('Unauthorized');
    }

    const impersonatedBy =
      typeof payload.impersonatedBy === 'string' && payload.impersonatedBy.length > 0
        ? payload.impersonatedBy
        : undefined;

    const user: JwtAuthUser = {
      id: payload.sub,
      username,
      role,
      name: String(payload.name || username).trim() || username,
      isActive: payload.isActive ?? true,
      ...(impersonatedBy ? { impersonatedBy } : {}),
    };

    if (process.env.NODE_ENV === 'development') {
      this.logger.debug(`JWT validated (stateless) for user: ${user.username} (${user.id})`);
    }

    return user;
  }
}
