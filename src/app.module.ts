import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { TransferModule } from './transfer/transfer.module';
import { RolesModule } from './roles/roles.module';
import { BettingGateway } from './betting/betting.gateway';
import { EntitySportModule } from './entitysport/entitysport.module';
import { BetfairController } from './betting/beffair.controller';
import { RedisModule } from './redis/redis.module';

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
    TransferModule,
    RolesModule,
    EntitySportModule,
    RedisModule,
  ],
  controllers: [AppController, BetfairController],
  providers: [AppService, BettingGateway],
})
export class AppModule {}
