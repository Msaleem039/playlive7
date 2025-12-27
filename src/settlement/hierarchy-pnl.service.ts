import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// @ts-ignore - MarketType exists after Prisma client regeneration
import { MarketType } from '@prisma/client';

@Injectable()
export class HierarchyPnlService {
  private readonly logger = new Logger(HierarchyPnlService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Distribute P/L up the hierarchy chain (LEDGER ONLY - NO WALLET UPDATES)
   * 
   * CRITICAL: This service ONLY writes to hierarchyPnl ledger table.
   * Wallet balance is NEVER touched here - wallet = credit only, PnL = separate ledger.
   * 
   * Logic:
   * - Client gets 100% exposure
   * - Each parent keeps only their commission difference
   * - Remaining P/L moves UP
   * 
   * Example:
   * Client (100%) → Agent (70%) → Admin (50%) → SuperAdmin (0%)
   * If Client loses 1000:
   * - Agent gets: (100 - 70) = 30% = +300
   * - Admin gets: (70 - 50) = 20% = +200
   * - SuperAdmin gets: (50 - 0) = 50% = +500
   * 
   * FINAL SETTLEMENT CALL ORDER (DO NOT BREAK):
   * 1. Update bet status (WON / LOST / CANCELLED)
   * 2. Release liability + wallet PnL (client only) - applyOutcome()
   * 3. Update userPnl.netPnl - recalculateUserPnlAfterSettlement()
   * 4. hierarchyPnlService.distributePnL() ← This method
   * 5. Mark event/market SETTLED ✅
   * 
   * @param userId - The user ID (client) whose P/L needs to be distributed
   * @param eventId - Event ID
   * @param marketType - Market type (FANCY, BOOKMAKER, MATCH_ODDS)
   * @param clientNetPnl - The net P/L of the client (MUST match userPnl.netPnl after step 3)
   */
  async distributePnL(
    userId: string,
    eventId: string,
    marketType: MarketType,
    clientNetPnl: number,
  ) {
    try {
      // Wrap entire operation in transaction for atomicity
      // CRITICAL: All hierarchy PnL writes must be atomic
      // Add timeout to prevent long-running transactions from causing connection issues
      await this.prisma.$transaction(
        async (tx) => {
        // Get the client's net P/L record to ensure it exists
        // @ts-ignore - userPnl property exists after Prisma client regeneration
        const userPnl = await tx.userPnl.findUnique({
          where: {
            userId_eventId_marketType: {
              userId,
              eventId,
              marketType,
            },
          },
        });

        if (!userPnl) {
          this.logger.warn(
            `No PnL record found for user ${userId}, event ${eventId}, marketType ${marketType}. Skipping hierarchical distribution.`,
          );
          return;
        }

        // CRITICAL FIX: Use clientNetPnl parameter (trusted value from settlement)
        // Cross-check with database value to detect sync issues
        const netPnl = clientNetPnl;
        
        if (userPnl.netPnl !== clientNetPnl) {
          this.logger.warn(
            `PnL mismatch detected for user ${userId}, event ${eventId}, marketType ${marketType}. ` +
            `Database value: ${userPnl.netPnl}, Settlement value: ${clientNetPnl}. Using settlement value.`,
          );
        }

        // If netPnl is zero, no distribution needed
        if (netPnl === 0) {
          this.logger.debug(
            `Net PnL is zero for user ${userId}, event ${eventId}, marketType ${marketType}. Skipping hierarchical distribution.`,
          );
          // Still mark as settled even if zero
          // @ts-ignore - hierarchySettled field may not exist yet (requires migration)
          await tx.userPnl.update({
            where: {
              userId_eventId_marketType: { userId, eventId, marketType },
            },
            // @ts-ignore - hierarchySettled field may not exist yet (requires migration)
            data: { hierarchySettled: true },
          }).catch(() => {
            // Ignore if field doesn't exist yet
          });
          return;
        }

        let currentUser = await tx.user.findUnique({
          where: { id: userId },
        });

        if (!currentUser) {
          this.logger.warn(`User ${userId} not found. Skipping hierarchical distribution.`);
          return;
        }

        // Idempotency: Delete existing records for this user/event/marketType
        // NO WALLET REVERSAL NEEDED - wallet is never touched in this service
        // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
        await tx.hierarchyPnl.deleteMany({
          where: {
            eventId,
            marketType,
            fromUserId: userId, // sourceUserId (original client)
          },
        });

        // Store original netPnl for calculating shares
        const originalNetPnl = netPnl;
        let childShare = 100; // Client always starts at 100%
        let distributedTotal = 0; // Track total distributed to handle floating-point remainder

        // Traverse up the hierarchy
        while (currentUser?.parentId) {
          const parent = await tx.user.findUnique({
            where: { id: currentUser.parentId },
          });

          if (!parent) {
            this.logger.warn(
              `Parent ${currentUser.parentId} not found for user ${currentUser.id}. Stopping hierarchy traversal.`,
            );
            break;
          }

          // CORRECT COMMISSION CALCULATION (Industry Standard)
          // commissionPercentage = what THIS USER keeps from downline PnL
          // Parent earns the DIFFERENCE between child's share and parent's share
          const parentShare = parent.commissionPercentage; // What parent keeps (e.g., 70% for Agent)
          const parentCommissionPct = (childShare - parentShare) / 100; // Difference (e.g., 30% for Agent)

          // Calculate the amount this parent receives
          // If client lost money (negative PnL), parent gains (positive amount)
          // If client won money (positive PnL), parent loses (negative amount)
          // We negate originalNetPnl because parent's gain/loss is opposite of child's
          const amount = -originalNetPnl * parentCommissionPct;

          // Track distributed total
          distributedTotal += amount;

          // CRITICAL: LEDGER ONLY - NO WALLET UPDATES
          // Wallet balance = credit only, managed separately via transfers
          // PnL distribution is tracked in hierarchyPnl ledger for reporting/audit
          // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
          await tx.hierarchyPnl.create({
            data: {
              eventId,
              marketType,
              fromUserId: userId, // sourceUserId (original client)
              toUserId: parent.id, // beneficiaryId (agent/admin/superadmin)
              amount,
              percentage: parentCommissionPct * 100,
            },
          });

          this.logger.debug(
            `Created hierarchical PnL ledger: client ${userId} → ${parent.id}, amount: ${amount}, commission: ${parentCommissionPct * 100}%`,
          );

          // Update for next iteration
          childShare = parentShare; // Next level uses parent's share as child's share
          currentUser = parent;
        }

        // 🔒 CRITICAL FIX: Force rounding correction on last parent
        // Floating-point drift can leave 0.02-0.05 undistributed, causing "settlement incomplete" warnings
        const expectedTotal = -originalNetPnl; // Total should be opposite of client's netPnl
        const remainder = expectedTotal - distributedTotal;

        if (Math.abs(remainder) > 0.01 && currentUser) {
          // Absorb remainder into the last parent (top of hierarchy)
          // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
          await tx.hierarchyPnl.create({
            data: {
              eventId,
              marketType,
              fromUserId: userId,
              toUserId: currentUser.id,
              amount: remainder,
              percentage: 0, // Remainder correction, not a commission percentage
            },
          });

          this.logger.debug(
            `Applied floating-point remainder correction: ${remainder} to user ${currentUser.id}`,
          );
        }

        // Mark hierarchy distribution as complete
        // This flag allows admin panel to verify settlement completion
        // @ts-ignore - hierarchySettled field may not exist yet (requires migration)
        await tx.userPnl.update({
          where: {
            userId_eventId_marketType: { userId, eventId, marketType },
          },
          // @ts-ignore - hierarchySettled field may not exist yet (requires migration)
          data: { hierarchySettled: true },
        }).catch(() => {
          // Ignore if field doesn't exist yet (will need database migration)
          this.logger.debug(
            `hierarchySettled field not found in userPnl table. Migration may be required.`,
          );
        });
        },
        {
          maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
          timeout: 30000, // Maximum time the transaction can run (30 seconds)
          isolationLevel: 'ReadCommitted', // Use ReadCommitted to reduce lock contention
        },
      );
    } catch (error) {
      const errorMessage = (error as Error).message;
      const isTransactionError = 
        errorMessage.includes('Transaction not found') ||
        errorMessage.includes('Transaction API error') ||
        errorMessage.includes('transaction') ||
        errorMessage.includes('P2034'); // Prisma transaction timeout error code

      if (isTransactionError) {
        this.logger.error(
          `Transaction error distributing hierarchical PnL for user ${userId}, event ${eventId}, marketType ${marketType}: ${errorMessage}`,
          (error as Error).stack,
        );
        // For transaction errors, we should retry once as they might be transient
        // But for now, just log and continue - settlement can complete without hierarchical PnL
      } else {
        this.logger.error(
          `Error distributing hierarchical PnL for user ${userId}, event ${eventId}, marketType ${marketType}: ${errorMessage}`,
          (error as Error).stack,
        );
      }
      // Don't throw - allow settlement to complete even if hierarchical distribution fails
      // But log the error so it can be investigated
    }
  }
}

