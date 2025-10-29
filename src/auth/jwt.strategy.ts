import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'your-super-secret-jwt-key-change-this-in-production-12345',
    });
  }

  async validate(payload: any) {
    console.log('JWT Strategy validate called with payload:', payload);
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
      throw new UnauthorizedException('Invalid token');
    }
  }
}
