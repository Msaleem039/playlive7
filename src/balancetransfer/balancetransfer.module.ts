import { Module } from '@nestjs/common';
import { BalanceTransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BalanceTransferController],
  providers: [TransferService],
  exports: [TransferService],
})
export class BalanceTransferModule {}

