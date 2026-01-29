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
import { BalanceTransferModule } from './balancetransfer/balancetransfer.module';
import { BetsModule } from './bets/bets.module';
import { ResultsModule } from './results/results.module';
import { SettlementModule } from './settlement/settlement.module';
import { SiteVideoModule } from './site-video/site-video.module';
import { PositionModule } from './positions/position.module';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from './common/redis/redis.module';
import { BackgroundProcessorModule } from './common/background/background-processor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule, // ✅ PERFORMANCE: Redis cache module (single cache layer)
    AuthModule,
    UsersModule,
    AdminModule,

    RolesModule,
    CricketIdModule,
    BalanceTransferModule,
    BetsModule,
    ResultsModule,
    SettlementModule,
    SiteVideoModule,
    PositionModule,
  ],
  controllers: [AppController, BetfairController],
  providers: [AppService, BettingGateway],
})
export class AppModule {}
