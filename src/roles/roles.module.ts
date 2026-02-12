import { Module } from '@nestjs/common';
import { SuperAdminController } from './superadmin.controller';
import { AdminController } from './admin.controller';
import { AgentController } from './agent.controller';
import { ClientController } from './client.controller';
import { AgentMatchBookService } from './agent-match-book.service';
import { AccountStatementService } from './account-statement.service';
import { TransferModule } from '../transfer/transfer.module';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PositionModule } from '../positions/position.module';
import { CricketIdModule } from '../cricketid/cricketid.module';

@Module({
  imports: [TransferModule, UsersModule, PrismaModule, PositionModule, CricketIdModule],
  controllers: [
    SuperAdminController,
    AdminController,
    AgentController,
    ClientController
  ],
  providers: [AgentMatchBookService, AccountStatementService],
})
export class RolesModule {}
