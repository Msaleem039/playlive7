import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionType, TransferLogType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TransferService {
  constructor(private prisma: PrismaService) {}

  async getUserChildren(userId: string) {
    const users = await this.prisma.user.findMany({
      where: { parentId: userId },
      include: {
        wallet: {
          select: { balance: true },
        },
      },
    });

    return users.map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      balance: user.wallet?.balance ?? 0,
      parentId: user.parentId,
      commissionPercentage: user.commissionPercentage,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));
  }

  async getHierarchyTree(userId: string) {
    // TODO: Implement hierarchy tree
    return { userId, message: 'Hierarchy tree not yet implemented' };
  }

  async getUserBalance(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });
    return { id: userId, balance: wallet?.balance ?? 0 };
  }

  async getTransferHistory(userId: string, limit?: number) {
    // TODO: Implement transfer history
    return [];
  }

  async transferFunds(fromUserId: string, dto: { toUserId: string; amount: number }) {
    // TODO: Implement fund transfer
    return { fromUserId, ...dto, message: 'Transfer not yet implemented' };
  }

  async updateCommissionPercentage(parentId: string, childId: string, commissionPercentage: number) {
    return this.prisma.user.update({
      where: { id: childId },
      data: { commissionPercentage },
    });
  }

  async createUserWithHierarchy(
    parentId: string,
    data: {
      name: string;
      username: string;
      password: string;
      role: string;
      commissionPercentage?: number;
      balance?: number;
    },
  ) {
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await this.prisma.user.create({
      data: {
        ...data,
        password: hashedPassword,
        parentId,
        role: data.role as any,
        commissionPercentage: data.commissionPercentage ?? 100,
      },
    });

    await this.prisma.wallet.create({
      data: {
        userId: user.id,
        balance: data.balance ?? 0,
        liability: 0,
      },
    });

    return user;
  }

  /**
   * Get account statement for a client
   * Returns transactions between client and their agent (TOPUP/TOPDOWN transfers)
   */
  async getAccountStatement(
    userId: string,
    options: {
      fromDate?: Date;
      toDate?: Date;
      type?: TransferLogType | 'ALL';
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const { fromDate, toDate, type = 'ALL', limit = 20, offset = 0 } = options;

    // Get user and their agent (parent)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        parentId: true,
        wallet: {
          select: {
            balance: true,
          },
        },
      },
    });

    if (!user) {
      return {
        openingBalance: 0,
        closingBalance: 0,
        total: 0,
        transactions: [],
      };
    }

    // If user has no agent, return empty statement
    if (!user.parentId) {
      return {
        openingBalance: user.wallet?.balance || 0,
        closingBalance: user.wallet?.balance || 0,
        total: 0,
        transactions: [],
      };
    }

    const agentId = user.parentId;
    const currentBalance = user.wallet?.balance || 0;

    // Build where clause for TransferLog - only transactions between client and agent
    const where: any = {
      OR: [
        // TOPUP: agent sends to client
        { fromUserId: agentId, toUserId: userId, type: TransferLogType.TOPUP },
        // TOPDOWN: client sends to agent (withdrawal)
        { fromUserId: userId, toUserId: agentId, type: TransferLogType.TOPDOWN },
      ],
    };

    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) {
        where.createdAt.gte = fromDate;
      }
      if (toDate) {
        // Set to end of day
        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = endDate;
      }
    }

    if (type !== 'ALL') {
      where.OR = where.OR.map((condition: any) => ({
        ...condition,
        type,
      }));
    }

    // Get total count for pagination
    const total = await this.prisma.transferLog.count({ where });

    // Calculate opening balance = Total credits (TOPUP) before the period start
    let openingBalance = 0;
    if (fromDate) {
      const whereBeforePeriod: any = {
        fromUserId: agentId,
        toUserId: userId,
        type: TransferLogType.TOPUP,
        createdAt: { lt: fromDate },
      };

      const topupsBeforePeriod = await this.prisma.transferLog.findMany({
        where: whereBeforePeriod,
        select: { amount: true },
      });

      openingBalance = topupsBeforePeriod.reduce((sum, t) => sum + t.amount, 0);
    } else {
      // If no fromDate, get all TOPUPs up to toDate (or all if no toDate)
      const whereAllTopups: any = {
        fromUserId: agentId,
        toUserId: userId,
        type: TransferLogType.TOPUP,
      };

      if (toDate) {
        whereAllTopups.createdAt = { lte: new Date(toDate) };
      }

      const allTopups = await this.prisma.transferLog.findMany({
        where: whereAllTopups,
        select: { amount: true },
      });

      openingBalance = allTopups.reduce((sum, t) => sum + t.amount, 0);
      
      // If there's a toDate, we need to subtract TOPUPs in the period for opening balance
      if (toDate && fromDate) {
        const whereTopupsInPeriod: any = {
          fromUserId: agentId,
          toUserId: userId,
          type: TransferLogType.TOPUP,
          createdAt: { gte: fromDate, lte: new Date(toDate) },
        };

        const topupsInPeriod = await this.prisma.transferLog.findMany({
          where: whereTopupsInPeriod,
          select: { amount: true },
        });

        const topupsInPeriodSum = topupsInPeriod.reduce((sum, t) => sum + t.amount, 0);
        openingBalance -= topupsInPeriodSum;
      }
    }

    // Get transfers in the filtered period (paginated)
    const transfers = await this.prisma.transferLog.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // Oldest first to calculate running balance correctly
      take: limit,
      skip: offset,
    });

    // Process transfers and calculate running balance
    // Balance = Total credits (TOPUP only) - running sum of credits
    const transactions: any[] = [];
    let runningCreditTotal = openingBalance; // Start with opening balance (total credits before period)

    for (const transfer of transfers) {
      // Determine if this is credit (client receives) or debit (client sends)
      const isCredit = transfer.type === TransferLogType.TOPUP && transfer.toUserId === userId;
      const isDebit = transfer.type === TransferLogType.TOPDOWN && transfer.fromUserId === userId;

      const credit = isCredit ? transfer.amount : 0;
      const debit = isDebit ? transfer.amount : 0;

      // Update running credit total: only add credits (TOPUP), ignore debits for balance
      if (isCredit) {
        runningCreditTotal += transfer.amount;
      }

      // Generate description
      const description = transfer.remarks || 
        (isCredit 
          ? `Top-up from agent` 
          : `Withdrawal to agent`);

      transactions.push({
        date: transfer.createdAt,
        credit: Math.round(credit * 100) / 100,
        debit: Math.round(debit * 100) / 100,
        commission: 0, // Transfers don't have commission (commission is on bet settlement)
        balance: Math.round(runningCreditTotal * 100) / 100, // Balance shows total credits up to this point
        description,
        type: transfer.type,
      });
    }

    // Closing balance = Total credits (TOPUP) up to the end of the period
    const closingBalance = runningCreditTotal;

    return {
      openingBalance: Math.round(openingBalance * 100) / 100,
      closingBalance: Math.round(closingBalance * 100) / 100,
      total,
      transactions: transactions.reverse(), // Return newest first for display
    };
  }
}

