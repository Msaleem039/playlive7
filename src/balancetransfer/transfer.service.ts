import {
    Injectable,
    ForbiddenException,
    BadRequestException,
  } from '@nestjs/common';
  import { PrismaService } from '../prisma/prisma.service';
  import { UserRole, type User } from '@prisma/client';
  import { BalanceChangeDto } from './dto/balance-change.dto';
  
  @Injectable()
  export class TransferService {
    constructor(private prisma: PrismaService) {}
  
    // =======================================================
    // 🔼 TOP-UP BALANCE
    // =======================================================
    async topUpBalance(currentUser: User, targetUserId: string, dto: BalanceChangeDto) {
      const { balance, remarks } = dto;
  
      const [fromUser, toUser] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: currentUser.id } }),
        this.prisma.user.findUnique({ where: { id: targetUserId } }),
      ]);
      if (!fromUser || !toUser) throw new BadRequestException('User not found');
  
      // ✅ Validate who can top-up whom
      this.validateRoleHierarchy(fromUser, toUser, 'TOPUP');
  
      // ✅ Super Admin self top-up doesn’t deduct from anyone
      const shouldDeduct = !(fromUser.role === UserRole.SUPER_ADMIN && fromUser.id === toUser.id);
  
      if (shouldDeduct && fromUser.balance < balance) {
        throw new BadRequestException('Insufficient balance');
      }
  
      return this.prisma.$transaction(async (tx) => {
        let updatedFromUser = fromUser;
  
        // ✅ Deduct from initiator (admin/agent)
        if (shouldDeduct) {
          updatedFromUser = await tx.user.update({
            where: { id: fromUser.id },
            data: { balance: { decrement: balance } },
          });
        }
  
        // ✅ Add to target
        const updatedToUser = await tx.user.update({
          where: { id: toUser.id },
          data: { balance: { increment: balance } },
        });
  
        // Log the transfer
        await tx.transferLog.create({
          data: {
            fromUserId: fromUser.id,
            toUserId: toUser.id,
            amount: balance,
            remarks,
            type: 'TOPUP',
          },
        });
  
        return {
          message: 'Top-up successful',
          fromUser: {
            id: updatedFromUser.id,
            name: updatedFromUser.name,
            balance: updatedFromUser.balance,
          },
          toUser: {
            id: updatedToUser.id,
            name: updatedToUser.name,
            balance: updatedToUser.balance,
          },
        };
      });
    }
  
    // =======================================================
    // 🔽 TOP-DOWN BALANCE (Withdraw)
    // =======================================================
    async topDownBalance(currentUser: User, targetUserId: string, dto: BalanceChangeDto) {
      const { balance, remarks } = dto;
  
      const [initiator, subordinate] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: currentUser.id } }),
        this.prisma.user.findUnique({ where: { id: targetUserId } }),
      ]);
      if (!initiator || !subordinate) throw new BadRequestException('User not found');
  
      // ✅ Role validation
      this.validateRoleHierarchy(initiator, subordinate, 'TOPDOWN');
  
      if (subordinate.balance < balance) {
        throw new BadRequestException('Subordinate has insufficient balance');
      }
  
      return this.prisma.$transaction(async (tx) => {
        // ✅ Deduct from subordinate (agent/client)
        const updatedSubordinate = await tx.user.update({
          where: { id: subordinate.id },
          data: { balance: { decrement: balance } },
        });
  
        // ✅ Add to initiator (admin/agent)
        const updatedInitiator = await tx.user.update({
          where: { id: initiator.id },
          data: { balance: { increment: balance } },
        });
  
        // Log transfer
        await tx.transferLog.create({
          data: {
            fromUserId: subordinate.id,
            toUserId: initiator.id,
            amount: balance,
            remarks,
            type: 'TOPDOWN',
          },
        });
  
        return {
          message: 'Top-down (withdraw) successful',
          initiator: {
            id: updatedInitiator.id,
            name: updatedInitiator.name,
            balance: updatedInitiator.balance,
          },
          subordinate: {
            id: updatedSubordinate.id,
            name: updatedSubordinate.name,
            balance: updatedSubordinate.balance,
          },
        };
      });
    }
  
    // =======================================================
    // 🧩 ROLE VALIDATION SHARED LOGIC
    // =======================================================
    private validateRoleHierarchy(actor: User, target: User, operation: 'TOPUP' | 'TOPDOWN') {
      if (actor.role === UserRole.SUPER_ADMIN) {
        // Super Admin can act on anyone, including self
        return;
      }
  
      if (actor.role === UserRole.ADMIN) {
        if (target.parentId !== actor.id || target.role !== UserRole.AGENT) {
          throw new ForbiddenException(
            `Admin can only ${operation === 'TOPUP' ? 'top-up' : 'withdraw from'} their agents`,
          );
        }
        return;
      }
  
      if (actor.role === UserRole.AGENT) {
        if (target.parentId !== actor.id || target.role !== UserRole.CLIENT) {
          throw new ForbiddenException(
            `Agent can only ${operation === 'TOPUP' ? 'top-up' : 'withdraw from'} their clients`,
          );
        }
        return;
      }
  
      throw new ForbiddenException('Clients are not allowed to perform this action');
    }

    // =======================================================
    // 📊 DASHBOARD SUMMARY FOR CURRENT USER
    // =======================================================
    async getDashboardSummary(currentUser: User) {
      const userId = currentUser.id;

      // 1️⃣ Get subordinates
      type Subordinate = {
        id: string;
        username: string;
        role: UserRole;
        balance: number;
      };

      const subordinates = await this.prisma.user.findMany({
        where: { parentId: userId },
        select: {
          id: true,
          username: true,
          role: true,
          balance: true,
        },
      }) as Subordinate[];

      const subordinateIds = subordinates.map(s => s.id);

      // 2️⃣ Get transfer logs where current user is involved
      const transfers = await this.prisma.transferLog.findMany({
        where: {
          OR: [
            { fromUserId: userId },
            { toUserId: userId },
            { fromUserId: { in: subordinateIds } },
            { toUserId: { in: subordinateIds } },
          ],
        },
      });

      // 3️⃣ Calculate total deposit (TOPUP done by this user)
      const totalDeposit = transfers
        .filter(t => t.type === 'TOPUP' && t.fromUserId === userId)
        .reduce((sum, t) => sum + t.amount, 0);

      // 4️⃣ Calculate total withdraw (TOPDOWN initiated by this user)
      const totalWithdraw = transfers
        .filter(t => t.type === 'TOPDOWN' && t.toUserId === userId)
        .reduce((sum, t) => sum + t.amount, 0);

      // 5️⃣ Client Balance (sum of all direct clients' balances)
      const clientBalance = subordinates
        .filter(s => s.role === UserRole.CLIENT)
        .reduce((sum, s) => sum + s.balance, 0);

      // 6️⃣ Total exposure (can be computed later — 0 for now)
      const totalExposure = 0;

      // 7️⃣ User count by role
      const userCountByRole = Object.entries(
        subordinates.reduce((acc, s) => {
          acc[s.role] = (acc[s.role] || 0) + 1;
          return acc;
        }, {} as Record<UserRole, number>)
      ).map(([role, count]) => ({ role, count }));

      // 8️⃣ Active clients (placeholder logic)
      const totalActiveClient = userCountByRole.find(r => r.role === UserRole.CLIENT)?.count || 0;

      // 9️⃣ Top 5 winning / losing players (optional placeholders)
      const topWinningPlayers = [];
      const topLosingPlayers = [];

      // 🔟 Top 5 markets (optional placeholders)
      const topWinningMarkets = [];
      const topLosingMarkets = [];

      return {
        totalDeposit,
        totalWithdraw,
        clientBalance,
        totalExposure,
        userCount: userCountByRole,
        totalActiveClient,
        topWinningPlayers,
        topLosingPlayers,
        topWinningMarkets,
        topLosingMarkets,
      };
    }
  }
