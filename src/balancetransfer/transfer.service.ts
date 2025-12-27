import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole, TransferLogType, type User } from '@prisma/client';
import { BalanceChangeDto } from './dto/balance-change.dto';

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);
  
  constructor(private prisma: PrismaService) {}

  // =======================================================
  // 🔼 TOP-UP BALANCE (uses Wallet.balance)
  // =======================================================
  async topUpBalance(
    currentUser: User,
    targetUserId: string,
    dto: BalanceChangeDto,
  ) {
    try {
      const { balance, remarks } = dto;

      this.logger.log(`Top-up request: from ${currentUser.id} to ${targetUserId}, amount: ${balance}`);

      const [fromUser, toUser] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: currentUser.id } }),
        this.prisma.user.findUnique({ where: { id: targetUserId } }),
      ]);
      if (!fromUser || !toUser) throw new BadRequestException('User not found');

      // ✅ Validate who can top-up whom
      this.validateRoleHierarchy(fromUser, toUser, 'TOPUP');

      // ✅ Super Admin self top-up doesn't deduct from anyone
      const shouldDeduct = !(
        fromUser.role === UserRole.SUPER_ADMIN && fromUser.id === toUser.id
      );

      // Configure transaction with timeout to prevent transaction invalidation
      // Note: Prisma automatically uses DIRECT_URL for transactions when configured in schema
      // Neon pooler doesn't support transactions well, so Prisma switches to direct connection
      return await this.prisma.$transaction(
        async (tx) => {
          let updatedFromWallet:
            | {
                id: string;
                balance: number;
              }
            | null = null;

          // ✅ Ensure wallets exist
          const fromWallet =
            shouldDeduct
              ? await tx.wallet.upsert({
                  where: { userId: fromUser.id },
                  update: {},
                  create: { userId: fromUser.id, balance: 0, liability: 0 },
                })
              : null;

          const toWalletInitial = await tx.wallet.upsert({
            where: { userId: toUser.id },
            update: {},
            create: { userId: toUser.id, balance: 0, liability: 0 },
          });

          // ✅ TOP-UP LOGIC - Simple accounting operation only
          // Transfer = cash movement, NO commission/share/profit calculation
          // Commission is earned ONLY when bets are settled, not during transfers
          const TOPUP_AMOUNT = balance;
          
          if (shouldDeduct) {
            // Check initiator balance (must have enough to cover the full top-up amount)
            if (fromWallet && fromWallet.balance < TOPUP_AMOUNT) {
              throw new BadRequestException('Insufficient balance');
            }

            // Deduct full amount from parent (simple accounting)
            if (fromWallet) {
              updatedFromWallet = await tx.wallet.update({
                where: { id: fromWallet.id },
                data: { 
                  balance: { decrement: TOPUP_AMOUNT }
                },
                select: { id: true, balance: true },
              });
            }
          }

          // ✅ Add full amount to target (100% playable credit)
          const updatedToWallet = await tx.wallet.update({
            where: { id: toWalletInitial.id },
            data: { balance: { increment: TOPUP_AMOUNT } },
            select: { id: true, balance: true },
          });

          // Log the transfer - do this BEFORE returning to ensure it completes
          await tx.transferLog.create({
            data: {
              fromUserId: fromUser.id,
              toUserId: toUser.id,
              amount: TOPUP_AMOUNT,
              remarks,
              type: TransferLogType.TOPUP,
            },
          });

          return {
            message: 'Top-up successful',
            fromUser: {
              id: fromUser.id,
              name: fromUser.name,
              balance: updatedFromWallet?.balance ?? null,
            },
            toUser: {
              id: toUser.id,
              name: toUser.name,
              balance: updatedToWallet.balance,
            },
          };
        },
        {
          maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
          timeout: 20000, // Maximum time the transaction can run (20 seconds)
        }
      );
    } catch (error) {
      this.logger.error(`Error in topUpBalance: ${error instanceof Error ? error.message : String(error)}`);
      this.logger.error(`Stack trace: ${error instanceof Error ? error.stack : 'No stack trace'}`);
      
      // Re-throw known exceptions
      if (error instanceof BadRequestException || error instanceof ForbiddenException) {
        throw error;
      }
      
      // Wrap unknown errors
      throw new InternalServerErrorException(
        `Failed to process top-up: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // =======================================================
  // 🔽 TOP-DOWN BALANCE (Withdraw) – uses Wallet.balance
  // =======================================================
  async topDownBalance(
    currentUser: User,
    targetUserId: string,
    dto: BalanceChangeDto,
  ) {
    const { balance, remarks } = dto;

    const [initiator, subordinate] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: currentUser.id } }),
      this.prisma.user.findUnique({ where: { id: targetUserId } }),
    ]);
    if (!initiator || !subordinate)
      throw new BadRequestException('User not found');

    // ✅ Role validation
    this.validateRoleHierarchy(initiator, subordinate, 'TOPDOWN');

    return this.prisma.$transaction(
      async (tx) => {
        // Ensure wallets
        const subordinateWallet = await tx.wallet.upsert({
          where: { userId: subordinate.id },
          update: {},
          create: { userId: subordinate.id, balance: 0, liability: 0 },
        });

        const initiatorWallet = await tx.wallet.upsert({
          where: { userId: initiator.id },
          update: {},
          create: { userId: initiator.id, balance: 0, liability: 0 },
        });

        // ✅ Check available balance (balance already excludes locked liability)
        // Available balance = balance (liability is already excluded from balance)
        const availableBalance = subordinateWallet.balance;
        
        if (availableBalance < balance) {
          throw new BadRequestException(
            'Subordinate has insufficient available balance',
          );
        }

        // ✅ Allow withdrawal based on role hierarchy
        // Withdrawal is allowed as long as there's sufficient available balance
        // Liability represents locked exposure from pending bets, but doesn't prevent
        // withdrawal of available balance by authorized roles (superadmin/admin/agent)

        // ✅ Deduct from subordinate (agent/client)
        const updatedSubordinateWallet = await tx.wallet.update({
          where: { id: subordinateWallet.id },
          data: { balance: { decrement: balance } },
          select: { id: true, balance: true },
        });

        // ✅ Add to initiator (admin/agent)
        const updatedInitiatorWallet = await tx.wallet.update({
          where: { id: initiatorWallet.id },
          data: { balance: { increment: balance } },
          select: { id: true, balance: true },
        });

        // Log transfer - do this BEFORE returning to ensure it completes
        await tx.transferLog.create({
          data: {
            fromUserId: subordinate.id,
            toUserId: initiator.id,
            amount: balance,
            remarks,
            type: TransferLogType.TOPDOWN,
          },
        });

        return {
          message: 'Top-down (withdraw) successful',
          initiator: {
            id: initiator.id,
            name: initiator.name,
            balance: updatedInitiatorWallet.balance,
          },
          subordinate: {
            id: subordinate.id,
            name: subordinate.name,
            balance: updatedSubordinateWallet.balance,
          },
        };
      },
      {
        maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
        timeout: 20000, // Maximum time the transaction can run (20 seconds)
      }
    );
  }

  // =======================================================
  // 🧩 ROLE VALIDATION SHARED LOGIC
  // =======================================================
  private validateRoleHierarchy(
    actor: User,
    target: User,
    operation: 'TOPUP' | 'TOPDOWN',
  ) {
    if (actor.role === UserRole.SUPER_ADMIN) {
      // Super Admin can act on anyone, including self
      return;
    }

    if (actor.role === UserRole.ADMIN) {
      if (target.parentId !== actor.id || target.role !== UserRole.AGENT) {
        throw new ForbiddenException(
          `Admin can only ${
            operation === 'TOPUP' ? 'top-up' : 'withdraw from'
          } their agents`,
        );
      }
      return;
    }

    if (actor.role === UserRole.AGENT) {
      if (target.parentId !== actor.id || target.role !== UserRole.CLIENT) {
        throw new ForbiddenException(
          `Agent can only ${
            operation === 'TOPUP' ? 'top-up' : 'withdraw from'
          } their clients`,
        );
      }
      return;
    }

    throw new ForbiddenException('Clients are not allowed to perform this action');
  }

  // =======================================================
  // 📊 DASHBOARD SUMMARY FOR CURRENT USER (Wallet + PnL based)
  // =======================================================
  /**
   * Get comprehensive dashboard summary for current user
   * 
   * Separates:
   * - Cash flow (transfers) - NOT profit
   * - Risk (exposure/liability)
   * - PnL (settled bets only) - actual profit/loss
   * - Users (subordinate counts)
   * 
   * CRITICAL: Uses userPnl and hierarchyPnl tables which aggregate
   * settled bet.pnl values (single source of truth from settlement).
   */
  async getDashboardSummary(currentUser: User) {
    const userId = currentUser.id;

    // ───────────────────────────────────────
    // 1️⃣ FETCH DIRECT SUBORDINATES + WALLETS
    // ───────────────────────────────────────
    const subordinates = await this.prisma.user.findMany({
      where: { parentId: userId },
      select: {
        id: true,
        role: true,
        wallet: {
          select: {
            balance: true,
            liability: true,
          },
        },
      },
    });

    const subordinateIds = subordinates.map((u) => u.id);

    // ───────────────────────────────────────
    // 2️⃣ CLIENT BALANCE & EXPOSURE (CRITICAL)
    // ───────────────────────────────────────
    let clientBalance = 0;
    let totalExposure = 0;

    for (const u of subordinates) {
      if (u.role === UserRole.CLIENT && u.wallet) {
        clientBalance += u.wallet.balance;
        totalExposure += u.wallet.liability;
      }
    }

    // ───────────────────────────────────────
    // 3️⃣-5️⃣ OPTIMIZED: Parallel fetch PnL, hierarchy PnL, and transfers
    // ───────────────────────────────────────
    // OPTIMIZED: Fetch all independent queries in parallel
    const [clientPnls, hierarchyPnls, transfers] = await Promise.all([
      // Client TOTAL PnL (SETTLED ONLY)
      // Uses userPnl table which aggregates bet.pnl (settlement truth)
      // @ts-ignore - userPnl property exists after Prisma client regeneration
      subordinateIds.length > 0
        ? this.prisma.userPnl.findMany({
            where: {
              userId: { in: subordinateIds },
            },
            select: { netPnl: true },
          })
        : Promise.resolve<Array<{ netPnl: number }>>([]),
      // ADMIN / AGENT NET PROFIT (HIERARCHY)
      // Uses hierarchyPnl table which distributes client PnL up the chain
      // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
      this.prisma.hierarchyPnl.findMany({
        where: {
          toUserId: userId,
        },
        select: { amount: true },
      }),
      // CASH FLOW (NOT PROFIT)
      // Transfers are cash movements, not profit calculations
      // Commission is earned ONLY when bets are settled, not during transfers
      this.prisma.transferLog.findMany({
        where: {
          OR: [{ fromUserId: userId }, { toUserId: userId }],
        },
        select: {
          type: true,
          amount: true,
          fromUserId: true,
          toUserId: true,
        },
      }),
    ]);

    const totalClientPnl = clientPnls.reduce((sum, p) => sum + p.netPnl, 0);
    const adminNetPnl = hierarchyPnls.reduce((sum, p) => sum + p.amount, 0);

    const totalDeposit = transfers
      .filter((t) => t.type === TransferLogType.TOPUP && t.fromUserId === userId)
      .reduce((sum, t) => sum + t.amount, 0);

    const totalWithdraw = transfers
      .filter((t) => t.type === TransferLogType.TOPDOWN && t.toUserId === userId)
      .reduce((sum, t) => sum + t.amount, 0);

    // ───────────────────────────────────────
    // 6️⃣ USER COUNTS
    // ───────────────────────────────────────
    const userCountByRole = subordinates.reduce(
      (acc, u) => {
        acc[u.role] = (acc[u.role] || 0) + 1;
        return acc;
      },
      {} as Record<UserRole, number>,
    );

    const totalActiveClient = userCountByRole[UserRole.CLIENT] || 0;

    // ───────────────────────────────────────
    // 7️⃣ ZERO-SUM VALIDATION (OPTIONAL LOG)
    // ───────────────────────────────────────
    // Client losses should ≈ admin + super-admin profit
    // This helps detect settlement bugs
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(
        `Dashboard Check → ClientPnL: ${totalClientPnl}, AdminPnL: ${adminNetPnl}`,
      );
    }

    // ───────────────────────────────────────
    // ✅ FINAL DASHBOARD RESPONSE
    // ───────────────────────────────────────
    return {
      cash: {
        totalDeposit,
        totalWithdraw,
        clientBalance,
      },
      risk: {
        totalExposure,
      },
      pnl: {
        clientTotalPnl: totalClientPnl,
        adminNetPnl,
      },
      users: {
        byRole: Object.entries(userCountByRole).map(([role, count]) => ({
          role,
          count,
        })),
        totalActiveClient,
      },
    };
  }
}
