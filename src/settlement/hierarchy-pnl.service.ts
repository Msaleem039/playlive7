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
   * IMPORTANT CALL ORDER (must be followed in SettlementService):
   * 1. Update bet status (WON / LOST)
   * 2. Unlock liability + wallet adjustment (client only)
   * 3. calculateUserPnl(userId, eventId)
   * 4. hierarchyPnlService.distributePnL(...) ← This method
   * 
   * @param userId - The user ID (client) whose P/L needs to be distributed
   * @param eventId - Event ID
   * @param marketType - Market type (FANCY, BOOKMAKER, MATCH_ODDS)
   * @param clientNetPnl - The net P/L of the client (can be positive or negative)
   */
  async distributePnL(
    userId: string,
    eventId: string,
    marketType: MarketType,
    clientNetPnl: number,
  ) {
    try {
      // Get the client's net P/L record to ensure it exists
      // @ts-ignore - userPnl property exists after Prisma client regeneration
      const userPnl = await this.prisma.userPnl.findUnique({
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

      // Use the actual netPnl from the database
      const netPnl = userPnl.netPnl;

      // If netPnl is zero, no distribution needed
      if (netPnl === 0) {
        this.logger.debug(
          `Net PnL is zero for user ${userId}, event ${eventId}, marketType ${marketType}. Skipping hierarchical distribution.`,
        );
        return;
      }

      let currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!currentUser) {
        this.logger.warn(`User ${userId} not found. Skipping hierarchical distribution.`);
        return;
      }

      // Idempotency: Delete existing records for this user/event/marketType
      // NO WALLET REVERSAL NEEDED - wallet is never touched in this service
      // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
      await this.prisma.hierarchyPnl.deleteMany({
        where: {
          eventId,
          marketType,
          fromUserId: userId, // sourceUserId (original client)
        },
      });

      // Store original netPnl for calculating shares
      const originalNetPnl = netPnl;
      let childShare = 100; // Client always starts at 100%

      // Traverse up the hierarchy
      while (currentUser?.parentId) {
        const parent = await this.prisma.user.findUnique({
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
        const amount = (-originalNetPnl * parentCommissionPct);

        // Only create record if amount is non-zero
        if (Math.abs(amount) > 0.01) {
          try {
            // CRITICAL: LEDGER ONLY - NO WALLET UPDATES
            // Wallet balance = credit only, managed separately via transfers
            // PnL distribution is tracked in hierarchyPnl ledger for reporting/audit
            // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
            await this.prisma.hierarchyPnl.create({
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
          } catch (error) {
            this.logger.error(
              `Failed to create hierarchical PnL record for ${currentUser.id} → ${parent.id}: ${(error as Error).message}`,
            );
            // Continue with next parent even if one fails
          }
        }

        // Update for next iteration
        childShare = parentShare; // Next level uses parent's share as child's share
        currentUser = parent;
      }

      // Verify that all PnL was distributed (should sum to originalNetPnl)
      // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
      const distributedRecords = await this.prisma.hierarchyPnl.findMany({
        where: {
          eventId,
          marketType,
          fromUserId: userId, // sourceUserId (original client)
        },
      });

      const totalDistributed = distributedRecords.reduce((sum, record) => sum + record.amount, 0);
      const expectedTotal = -originalNetPnl; // Total should be opposite of client's netPnl

      // Allow small floating point differences
      if (Math.abs(totalDistributed - expectedTotal) > 0.01) {
        this.logger.warn(
          `PnL distribution mismatch for user ${userId}, event ${eventId}, marketType ${marketType}. Expected total: ${expectedTotal}, Actual total: ${totalDistributed}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error distributing hierarchical PnL for user ${userId}, event ${eventId}, marketType ${marketType}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Don't throw - allow settlement to complete even if hierarchical distribution fails
    }
  }
}

