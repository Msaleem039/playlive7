import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
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

  async validate(payload: any) {
    // Validate payload structure
    if (!payload || !payload.sub) {
      this.logger.warn('JWT payload missing required fields (sub)');
      throw new UnauthorizedException('Invalid token: missing user identifier');
    }

    // Check if token is expired (should be caught by passport-jwt, but double-check)
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      this.logger.warn(`JWT token expired for user ${payload.sub} (exp: ${new Date(payload.exp * 1000).toISOString()})`);
      throw new UnauthorizedException('Token expired');
    }

    try {
      const user = await this.usersService.findById(payload.sub);
      
      if (!user) {
        // Log user not found with context (safe to log user ID in this case)
        this.logger.warn(`User not found for JWT payload sub: ${payload.sub}`);
        throw new UnauthorizedException('Invalid token: user not found');
      }

      // Log successful validation in debug mode only
      if (process.env.NODE_ENV === 'development') {
        this.logger.debug(`JWT validated successfully for user: ${user.username} (${user.id})`);
      }

      return user;
    } catch (error) {
      // If it's already an UnauthorizedException, re-throw it
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      // Handle database errors
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        
        // Database connection errors
        if (
          errorMessage.includes("can't reach database") ||
          errorMessage.includes('p1001') ||
          errorMessage.includes('p2021') ||
          errorMessage.includes('connection') ||
          errorMessage.includes('timeout')
        ) {
          this.logger.error(`Database error during JWT validation for user ${payload.sub}: ${error.message}`);
          
          // In production, fail fast on database errors
          if (process.env.NODE_ENV === 'production') {
            throw new UnauthorizedException('Authentication service unavailable');
          }
          
          // In development, allow fallback (but log warning)
          this.logger.warn('Database unavailable - using payload data (development mode only)');
          return {
            id: payload.sub,
            role: payload.role || 'USER',
            name: 'Development User',
            username: payload.username || 'dev',
            email: null,
            password: '',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
      }

      // Unknown error - log and throw generic error
      this.logger.error(`Unexpected error in JWT validation for user ${payload.sub}:`, error);
      throw new UnauthorizedException('Invalid token: validation failed');
    }
  }
}
