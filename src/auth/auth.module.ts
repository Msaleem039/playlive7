import { Module, Logger } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtStrategy } from './jwt.strategy';
import { AccountStatementService } from '../roles/account-statement.service';

@Module({
  imports: [
    UsersModule, // Import UsersModule to access UsersService
    PrismaModule, // Import PrismaModule to access PrismaService
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => {
        const jwtSecret = configService.get<string>('JWT_SECRET');
        const logger = new Logger('AuthModule');

        // Validate JWT_SECRET on startup
        if (!jwtSecret) {
          const errorMsg = 'JWT_SECRET is not set in environment variables. Authentication will fail.';
          logger.error(errorMsg);
          if (process.env.NODE_ENV === 'production') {
            throw new Error(errorMsg);
          }
          logger.warn('⚠️  Using fallback JWT_SECRET (NOT SECURE - set JWT_SECRET in production!)');
        } else {
          // Validate JWT_SECRET is not the default insecure value
          if (jwtSecret === 'your-super-secret-jwt-key-change-this-in-production-12345') {
            logger.warn('⚠️  JWT_SECRET is set to default insecure value. Change it in production!');
          } else {
            logger.log('✅ JWT_SECRET validated');
          }
        }

        return {
          secret: jwtSecret || 'your-super-secret-jwt-key-change-this-in-production-12345',
          signOptions: {
            expiresIn: '7d',
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, JwtStrategy, AccountStatementService],
  controllers: [AuthController],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
