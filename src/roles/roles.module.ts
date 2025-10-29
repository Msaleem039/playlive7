import { Module } from '@nestjs/common';
import { SuperAdminController } from './superadmin.controller';
import { AdminController } from './admin.controller';
import { AgentController } from './agent.controller';
import { ClientController } from './client.controller';
import { TransferModule } from '../transfer/transfer.module';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [TransferModule, UsersModule, PrismaModule],
  controllers: [
    SuperAdminController,
    AdminController,
    AgentController,
    ClientController
  ],
})
export class RolesModule {}
