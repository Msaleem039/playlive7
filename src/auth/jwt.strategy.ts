import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
    private prismaService: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'your-super-secret-jwt-key-change-this-in-production-12345',
    });
  }

  async validate(payload: any) {
    // console.log('JWT Strategy validate called with payload:', payload);
    
    // Check if database is connected
    const isDbConnected = this.prismaService.isDatabaseConnected();
    
    // If database is not connected in development, return minimal user object
    if (!isDbConnected && process.env.NODE_ENV !== 'production') {
      console.warn('Database not connected - using payload data (development mode)');
      return {
        id: payload.sub,
        role: payload.role,
        name: 'Development User',
        username: payload.username || 'dev',
        email: null,
        password: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    
    // If database is not connected in production, throw error
    if (!isDbConnected && process.env.NODE_ENV === 'production') {
      console.error('Database not connected in production!');
      throw new UnauthorizedException('Database connection error');
    }
    
    try {
      const user = await this.usersService.findById(payload.sub);
      console.log('User found:', user);
      if (!user) {
        console.log('User not found for ID:', payload.sub);
        throw new UnauthorizedException('Invalid token');
      }
      return user;
    } catch (error) {
      console.error('Error in JWT strategy validate:', error);
      // In development, if database error occurs, allow token validation to proceed with payload
      if (process.env.NODE_ENV !== 'production' && 
          error instanceof Error && 
          (error.message.includes("Can't reach database") || 
           error.message.includes("P1001") ||
           error.message.includes("P2021"))) {
        console.warn('Database error - using payload data (development mode)');
        return {
          id: payload.sub,
          role: payload.role,
          name: 'Development User',
          username: payload.username || 'dev',
          email: null,
          password: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }
      throw new UnauthorizedException('Invalid token');
    }
  }
}
