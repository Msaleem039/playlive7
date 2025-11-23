import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';

import { RolesModule } from './roles/roles.module';
import { BettingGateway } from './betting/betting.gateway';
import { CricketIdModule } from './cricketid/cricketid.module';
import { BetfairController } from './betting/beffair.controller';
import { RedisModule } from './redis/redis.module';
import { BalanceTransferModule } from './balancetransfer/balancetransfer.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    AdminModule,

    RolesModule,
    CricketIdModule,
    RedisModule,
    BalanceTransferModule,
  ],
  controllers: [AppController, BetfairController],
  providers: [AppService, BettingGateway],
})
export class AppModule {}
