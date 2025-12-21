import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BetStatus, PrismaClient, TransactionType } from '@prisma/client';
// @ts-ignore - MarketType exists after Prisma client regeneration
import { MarketType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CricketIdService } from '../cricketid/cricketid.service';
import { PnlService } from './pnl.service';
import { HierarchyPnlService } from './hierarchy-pnl.service';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private loggedTableMissing = false; // Track if we've already logged the table missing warning

  constructor(
    private readonly prisma: PrismaService,
    private readonly cricketIdService: CricketIdService,
    private readonly pnlService: PnlService,
    private readonly hierarchyPnlService: HierarchyPnlService,
  ) {}

  async settleFancyAuto(eventId: string) {
    const fancyResults = await this.cricketIdService.getFancyResult(eventId);

    // Handle response format - check if it's wrapped in a data property
    const results = Array.isArray(fancyResults)
      ? fancyResults
      : (fancyResults as any)?.data || (fancyResults as any)?.status?.data || [];

    for (const fancy of results) {
      // Skip if neither declared nor cancelled
      if (!fancy.isDeclare && !fancy.isCancel) continue;

      const settlementId = `CRICKET:FANCY:${eventId}:${fancy.selectionId}`;

      // Check if settlement already exists (prevent double settlement)
      // @ts-ignore - settlement property exists after Prisma client regeneration
      const existingSettlement = await this.prisma.settlement.findUnique({
        where: { settlementId },
      });

      if (existingSettlement && !existingSettlement.isRollback) {
        this.logger.warn(
          `Settlement ${settlementId} already exists, skipping...`,
        );
        continue;
      }

    const bets = await this.prisma.bet.findMany({
      where: {
          settlementId,
        status: BetStatus.PENDING,
      },
    });

    if (bets.length === 0) {
          continue;
        }

      // Create settlement record FIRST
      // @ts-ignore - settlement property exists after Prisma client regeneration
      await this.prisma.settlement.upsert({
        where: { settlementId },
        update: {
          isRollback: false,
          settledBy: 'AUTO',
        },
        create: {
          settlementId,
          eventId,
          marketType: MarketType.FANCY,
          marketId: fancy.marketId?.toString(),
          winnerId: fancy.isCancel ? null : fancy.decisionRun?.toString(),
          settledBy: 'AUTO',
        },
      });

      const userIds = new Set<string>();

      for (const bet of bets) {
        let result: { status: BetStatus; pnl: number };

        // Handle cancellation (refund stake)
        if (fancy.isCancel || fancy.isRollback) {
          // Refund the stake amount (amount field)
          result = { status: BetStatus.CANCELLED, pnl: bet.amount ?? 0 };
        } else if (fancy.isDeclare) {
          // Handle declared fancy with BACK/LAY logic
          if (bet.betType === 'BACK') {
            const betValue = bet.betValue ?? 0;
            const lossAmount = bet.lossAmount ?? 0;
            result =
              fancy.decisionRun > betValue
                ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
                : { status: BetStatus.LOST, pnl: -lossAmount };
          } else {
            const betValue = bet.betValue ?? 0;
            const lossAmount = bet.lossAmount ?? 0;
            result =
              fancy.decisionRun <= betValue
                ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
                : { status: BetStatus.LOST, pnl: -lossAmount };
          }
        } else {
          // Skip if neither declared nor cancelled
          continue;
        }

        await this.applyOutcome(bet, result);
        userIds.add(bet.userId);
      }

      // Recalculate P/L for all affected users
      for (const userId of userIds) {
        try {
          await this.pnlService.recalculateUserPnlAfterSettlement(
            userId,
            eventId,
          );
          // Distribute hierarchical P/L for FANCY market
          // @ts-ignore - userPnl property exists after Prisma client regeneration
          const userPnl = await this.prisma.userPnl.findUnique({
            where: {
              userId_eventId_marketType: {
                userId,
                eventId,
                marketType: MarketType.FANCY,
              },
            },
          });
          if (userPnl) {
            await this.hierarchyPnlService.distributePnL(
              userId,
              eventId,
              MarketType.FANCY,
              userPnl.netPnl,
            );
          }
      } catch (error) {
          this.logger.warn(
            `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
          );
        }
      }
    }
  }

  async settleFancyManual(
    eventId: string,
    selectionId: string,
    decisionRun: number | null,
    isCancel: boolean,
    marketId: string | null,
    adminId: string,
  ) {
    const settlementId = `CRICKET:FANCY:${eventId}:${selectionId}`;

    // Check if settlement already exists (prevent double settlement)
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const existingSettlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (existingSettlement && !existingSettlement.isRollback) {
      throw new BadRequestException(
        `Settlement ${settlementId} already exists`,
      );
    }

    // Find bets with new format first
    let bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
        eventId: eventId,
        selectionId: Number(selectionId),
      },
    });

    // If no bets found with new format, try to find bets with old format (legacy: ${match_id}_${selection_id})
    // For fancy, the old format was ${match_id}_${selection_id}, so we can match by eventId and selectionId
    if (bets.length === 0) {
      // Try finding bets by eventId and selectionId
      bets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          selectionId: Number(selectionId),
          status: BetStatus.PENDING,
          // Fancy bets typically have gtype containing "fancy"
          OR: [
            { gtype: { contains: 'fancy', mode: 'insensitive' } },
            { marketType: { contains: 'fancy', mode: 'insensitive' } },
          ],
        },
      });

      // If we found bets with old format, update their settlementId to the new format
      if (bets.length > 0) {
        this.logger.log(
          `Found ${bets.length} bets with legacy format for eventId ${eventId}, selectionId ${selectionId}. Updating settlementId to new format.`,
        );
        
        // Update settlementId for all found bets
        await this.prisma.bet.updateMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
          data: {
            settlementId: settlementId,
          },
        });

        // Refresh bets to get updated settlementId
        bets = await this.prisma.bet.findMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
        });
      }
    }

    if (bets.length === 0) {
      return { success: true, message: 'No pending bets to settle' };
    }

    // Create settlement record FIRST
    // @ts-ignore - settlement property exists after Prisma client regeneration
    await this.prisma.settlement.upsert({
      where: { settlementId },
      update: {
        isRollback: false,
        settledBy: adminId,
      },
      create: {
        settlementId,
        eventId,
        marketType: MarketType.FANCY,
        marketId: marketId || null,
        winnerId: isCancel ? null : (decisionRun?.toString() || null),
        settledBy: adminId,
      },
    });

    const userIds = new Set<string>();

    for (const bet of bets) {
      let result: { status: BetStatus; pnl: number };

      // Handle cancellation (refund stake)
      if (isCancel) {
        // Refund the stake amount (amount field)
        result = { status: BetStatus.CANCELLED, pnl: bet.amount ?? 0 };
      } else if (decisionRun !== null) {
        // Handle declared fancy with BACK/LAY logic
        if (bet.betType === 'BACK') {
          const betValue = bet.betValue ?? 0;
          const lossAmount = bet.lossAmount ?? 0;
          result =
            decisionRun > betValue
              ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
              : { status: BetStatus.LOST, pnl: -lossAmount };
        } else {
          const betValue = bet.betValue ?? 0;
          const lossAmount = bet.lossAmount ?? 0;
          result =
            decisionRun <= betValue
              ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
              : { status: BetStatus.LOST, pnl: -lossAmount };
        }
      } else {
        throw new BadRequestException(
          'Either decisionRun or isCancel must be provided',
        );
      }

      await this.applyOutcome(bet, result);
      userIds.add(bet.userId);
    }

    // Recalculate P/L for all affected users
    for (const userId of userIds) {
      try {
        await this.pnlService.recalculateUserPnlAfterSettlement(
          userId,
          eventId,
        );
        // Distribute hierarchical P/L for FANCY market
        // @ts-ignore - userPnl property exists after Prisma client regeneration
        const userPnl = await this.prisma.userPnl.findUnique({
          where: {
            userId_eventId_marketType: {
              userId,
              eventId,
              marketType: MarketType.FANCY,
            },
          },
        });
        if (userPnl) {
          await this.hierarchyPnlService.distributePnL(
            userId,
            eventId,
            MarketType.FANCY,
            userPnl.netPnl,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
        );
      }
    }

    return { success: true, message: 'Fancy bets settled successfully' };
  }

  async settleBookmakerManual(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    adminId: string,
  ) {
    const settlementId = `CRICKET:BOOKMAKER:${eventId}:${marketId}`;

    // Check if settlement already exists (prevent double settlement)
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const existingSettlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (existingSettlement && !existingSettlement.isRollback) {
      throw new BadRequestException(
        `Settlement ${settlementId} already exists`,
      );
    }

    // Find bets with new format first
    let bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
        eventId: eventId,
        marketId: marketId,
      },
    });

    // If no bets found with new format, try to find bets with old format (legacy: ${match_id}_${selection_id})
    // For bookmaker, we need to find all bets for this eventId and marketId regardless of selectionId
    if (bets.length === 0) {
      // Try finding bets by eventId and marketId (for bookmaker, all selections in same market should be settled together)
      bets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          marketId: marketId,
          status: BetStatus.PENDING,
          // Bookmaker bets typically have gtype containing "bookmaker" or "book"
          OR: [
            { gtype: { contains: 'bookmaker', mode: 'insensitive' } },
            { gtype: { contains: 'book', mode: 'insensitive' } },
            { marketType: { contains: 'bookmaker', mode: 'insensitive' } },
            { marketType: { contains: 'book', mode: 'insensitive' } },
          ],
        },
      });

      // If we found bets with old format, update their settlementId to the new format
      if (bets.length > 0) {
        this.logger.log(
          `Found ${bets.length} bets with legacy format for eventId ${eventId}, marketId ${marketId}. Updating settlementId to new format.`,
        );
        
        // Update settlementId for all found bets
        await this.prisma.bet.updateMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
          data: {
            settlementId: settlementId,
          },
        });

        // Refresh bets to get updated settlementId
        bets = await this.prisma.bet.findMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
        });
      }
    }

    if (bets.length === 0) {
      return { success: true, message: 'No pending bets to settle' };
    }

    // Create settlement record FIRST
    // @ts-ignore - settlement property exists after Prisma client regeneration
    await this.prisma.settlement.upsert({
      where: { settlementId },
      update: {
        isRollback: false,
        settledBy: adminId,
      },
      create: {
        settlementId,
        eventId,
        marketType: MarketType.BOOKMAKER,
        marketId,
        winnerId: winnerSelectionId,
        settledBy: adminId,
      },
    });

    const winnerSelectionIdNum = Number(winnerSelectionId);
    const userIds = new Set<string>();

    for (const bet of bets) {
      let result: { status: BetStatus; pnl: number };
      const lossAmount = bet.lossAmount ?? 0;

      if (bet.selectionId === winnerSelectionIdNum) {
        result =
          bet.betType === 'BACK'
            ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
            : { status: BetStatus.LOST, pnl: -lossAmount };
      } else {
        result =
          bet.betType === 'LAY'
            ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
            : { status: BetStatus.LOST, pnl: -lossAmount };
      }

      await this.applyOutcome(bet, result);
      userIds.add(bet.userId);
    }

    // Recalculate P/L for all affected users
    for (const userId of userIds) {
      try {
        await this.pnlService.recalculateUserPnlAfterSettlement(
          userId,
          eventId,
        );
        // Distribute hierarchical P/L for BOOKMAKER market
        // @ts-ignore - userPnl property exists after Prisma client regeneration
        const userPnl = await this.prisma.userPnl.findUnique({
          where: {
            userId_eventId_marketType: {
              userId,
              eventId,
              marketType: MarketType.BOOKMAKER,
            },
          },
        });
        if (userPnl) {
          await this.hierarchyPnlService.distributePnL(
            userId,
            eventId,
            MarketType.BOOKMAKER,
            userPnl.netPnl,
          );
        }
        } catch (error) {
          this.logger.warn(
          `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
        );
      }
    }

    return { success: true, message: 'Bookmaker bets settled successfully' };
  }

  async settleMatchOddsManual(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    adminId: string,
  ) {
    try {
      // Validate required parameters
      if (!eventId || eventId === 'undefined' || eventId.trim() === '') {
        throw new BadRequestException('eventId is required and cannot be empty');
      }
      if (!marketId || marketId === 'undefined' || marketId.trim() === '') {
        throw new BadRequestException('marketId is required and cannot be empty');
      }
      if (!winnerSelectionId || winnerSelectionId === 'undefined' || winnerSelectionId.trim() === '') {
        throw new BadRequestException('winnerSelectionId is required and cannot be empty');
      }
      if (!adminId || adminId.trim() === '') {
        throw new BadRequestException('adminId is required');
      }

      const settlementId = `CRICKET:MATCHODDS:${eventId}:${marketId}`;

      // Check if settlement already exists (prevent double settlement)
      // @ts-ignore - settlement property exists after Prisma client regeneration
      const existingSettlement = await this.prisma.settlement.findUnique({
        where: { settlementId },
      });

      if (existingSettlement && !existingSettlement.isRollback) {
        throw new BadRequestException(
          `Settlement ${settlementId} already exists`,
        );
      }

      // Find bets with new format first
      let bets = await this.prisma.bet.findMany({
        where: {
          settlementId,
          status: BetStatus.PENDING,
          ...(eventId && { eventId: eventId }),
          ...(marketId && { marketId: marketId }),
        },
      });

    // If no bets found with new format, try to find bets with legacy formats
    // This includes:
    // 1. Old format: ${match_id}_${selection_id}
    // 2. New format with undefined: CRICKET:MATCHODDS:undefined:undefined
    // 3. Bets matching by eventId (marketId might be missing from old bets)
    if (bets.length === 0) {
      // Query all pending bets for this eventId first (most reliable)
      const allEventBets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          status: BetStatus.PENDING,
        },
      });

      // Filter to match odds bets - check settlementId patterns
      bets = allEventBets.filter((bet) => {
        const sid = bet.settlementId || '';
        // Match if:
        // 1. Has "undefined" in settlementId (legacy format issue)
        // 2. Has "MATCHODDS" or "MATCH_ODDS" in settlementId
        // 3. Starts with eventId_ (old format)
        // 4. Or if marketId matches (if both are provided)
        return (
          sid.includes('undefined') ||
          sid.includes('MATCHODDS') ||
          sid.includes('MATCH_ODDS') ||
          sid.startsWith(`${eventId}_`) ||
          (marketId && bet.marketId === marketId) ||
          (!bet.marketId && marketId) // If bet doesn't have marketId but we're settling with one
        );
      });

      this.logger.log(
        `Found ${bets.length} match odds bets for eventId ${eventId} (out of ${allEventBets.length} total pending bets)`,
      );

      // If we found bets with old format, update their settlementId and marketId to the new format
      if (bets.length > 0) {
        this.logger.log(
          `Found ${bets.length} bets with legacy format for eventId ${eventId}, marketId ${marketId}. Updating settlementId and marketId to new format.`,
        );
        
        const betIds = bets.map((b) => b.id).filter((id) => id); // Filter out any null/undefined IDs
        if (betIds.length > 0) {
          // Update settlementId and marketId for all found bets
          // This fixes bets that have "undefined" in their settlementId or missing marketId
          await this.prisma.bet.updateMany({
            where: {
              id: { in: betIds },
            },
            data: {
              settlementId: settlementId,
              ...(marketId && { marketId: marketId }), // Update marketId if provided
              ...(eventId && { eventId: eventId }), // Ensure eventId is set
            },
          });

          // Refresh bets to get updated settlementId
          bets = await this.prisma.bet.findMany({
            where: {
              id: { in: betIds },
            },
          });
        }
      }
    }

    if (bets.length === 0) {
      return { success: true, message: 'No pending bets to settle' };
    }

    // Create settlement record FIRST
    // @ts-ignore - settlement property exists after Prisma client regeneration
    await this.prisma.settlement.upsert({
      where: { settlementId },
      update: {
        isRollback: false,
        settledBy: adminId,
      },
      create: {
        settlementId,
        eventId,
        marketType: MarketType.MATCH_ODDS,
        marketId,
        winnerId: winnerSelectionId,
        settledBy: adminId,
      },
    });

    const winnerSelectionIdNum = Number(winnerSelectionId);
    const userIds = new Set<string>();

    for (const bet of bets) {
      let result: { status: BetStatus; pnl: number };
      const lossAmount = bet.lossAmount ?? 0;

      if (bet.selectionId === winnerSelectionIdNum) {
        result =
          bet.betType === 'BACK'
            ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
            : { status: BetStatus.LOST, pnl: -lossAmount };
        } else {
        result =
          bet.betType === 'LAY'
            ? { status: BetStatus.WON, pnl: bet.winAmount ?? 0 }
            : { status: BetStatus.LOST, pnl: -lossAmount };
      }

      await this.applyOutcome(bet, result);
      userIds.add(bet.userId);
    }

    // Recalculate P/L for all affected users
    for (const userId of userIds) {
      try {
        await this.pnlService.recalculateUserPnlAfterSettlement(
          userId,
          eventId,
        );
        // Distribute hierarchical P/L for MATCH_ODDS market
        // @ts-ignore - userPnl property exists after Prisma client regeneration
        const userPnl = await this.prisma.userPnl.findUnique({
          where: {
            userId_eventId_marketType: {
              userId,
              eventId,
              marketType: MarketType.MATCH_ODDS,
            },
          },
        });
        if (userPnl) {
          await this.hierarchyPnlService.distributePnL(
            userId,
            eventId,
            MarketType.MATCH_ODDS,
            userPnl.netPnl,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
        );
      }
    }

    return { success: true, message: 'Match odds bets settled successfully' };
    } catch (error) {
      this.logger.error(
        `Error settling match odds for eventId ${eventId}, marketId ${marketId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      
      // Re-throw BadRequestException as-is
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Wrap other errors in BadRequestException for proper HTTP response
      throw new BadRequestException(
        `Failed to settle match odds: ${(error as Error).message}`,
      );
    }
  }

  private async applyOutcome(
    bet: any,
    outcome: { status: BetStatus; pnl: number },
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (outcome.pnl !== 0) {
      await tx.wallet.update({
          where: { userId: bet.userId },
        data: {
            balance: { increment: outcome.pnl },
        },
      });
    }

      await tx.bet.update({
        where: { id: bet.id },
        data: {
          status: outcome.status,
          // @ts-ignore - pnl field exists after database migration
          pnl: outcome.pnl,
          settledAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }

  async rollbackSettlement(settlementId: string, adminId: string) {
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const settlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (!settlement || settlement.isRollback) {
      throw new BadRequestException(
        'Invalid or already rollbacked settlement',
      );
    }

    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
      status: {
        in: [BetStatus.WON, BetStatus.LOST],
      },
      },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const bet of bets) {
        // Reverse wallet
        // @ts-ignore - pnl field exists after database migration
        if (bet.pnl !== 0) {
          await tx.wallet.update({
            where: { userId: bet.userId },
            data: {
              // @ts-ignore - pnl field exists after database migration
              balance: { increment: -bet.pnl },
            },
          });
        }

        // Reset bet
        await tx.bet.update({
          where: { id: bet.id },
          data: {
            status: BetStatus.PENDING,
            // @ts-ignore - pnl field exists after database migration
            pnl: 0,
            rollbackAt: new Date(),
            settledAt: null,
            updatedAt: new Date(),
          },
        });
      }

      // Mark settlement as rollbacked
      // @ts-ignore - settlement property exists after Prisma client regeneration
      await tx.settlement.update({
        where: { settlementId },
            data: {
          isRollback: true,
          settledBy: adminId,
            },
          });
    });

    // Delete hierarchical PnL ledger records (NO WALLET REVERSAL - wallet is never touched in PnL distribution)
    const userIds = new Set(bets.map((b) => b.userId));
    for (const userId of userIds) {
      try {
        // Delete hierarchical PnL ledger records
        // Wallet balance is never updated by hierarchy PnL, so no reversal needed
        // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
        await this.prisma.hierarchyPnl.deleteMany({
          where: {
            eventId: settlement.eventId,
            marketType: settlement.marketType,
            fromUserId: userId, // sourceUserId (original client)
          },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to delete hierarchical PnL records for user ${userId} during rollback: ${(error as Error).message}`,
        );
      }
    }

    // Recalculate P/L for all affected users after rollback
    for (const userId of userIds) {
      try {
        await this.pnlService.recalculateUserPnlAfterSettlement(
          userId,
          settlement.eventId,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to recalculate P/L for user ${userId} after rollback: ${(error as Error).message}`,
        );
      }
    }

    return { success: true, message: 'Settlement rolled back successfully' };
  }

  /**
   * Delete a bet for a specific user (Admin only)
   * Refunds the wallet balance and releases liability
   * Can delete by betId or settlementId
   */
  async deleteBet(betIdOrSettlementId: string, adminId: string) {
    // Try to find bet by ID first, then by settlementId
    let bet = await this.prisma.bet.findFirst({
      where: {
        OR: [
          { id: betIdOrSettlementId },
          { settlementId: betIdOrSettlementId },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
      },
    });

    if (!bet) {
      throw new BadRequestException(
        `Bet not found with ID or settlementId: ${betIdOrSettlementId}`,
      );
    }

    // Only allow deletion of PENDING bets
    if (bet.status !== BetStatus.PENDING) {
      throw new BadRequestException(
        `Cannot delete bet with status ${bet.status}. Only PENDING bets can be deleted.`,
      );
    }

    // Calculate refund amount
    // For pending bets, lossAmount contains the locked liability
    const refundAmount = bet.lossAmount || bet.amount || 0;

    if (refundAmount <= 0) {
      throw new BadRequestException(
        'Bet has no amount to refund. Cannot delete bet.',
      );
    }

    // Get wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: bet.userId },
    });

    if (!wallet) {
      throw new BadRequestException(`Wallet not found for user ${bet.userId}`);
    }

    // Refund balance and release liability in a transaction
    await this.prisma.$transaction(async (tx) => {
      // Refund balance and release liability
      await tx.wallet.update({
        where: { userId: bet.userId },
        data: {
          balance: { increment: refundAmount },
          liability: { decrement: refundAmount },
        },
      });

      // Create refund transaction record
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          amount: refundAmount,
          type: TransactionType.REFUND,
          description: `Bet deleted by admin. Bet ID: ${bet.id}, Settlement ID: ${bet.settlementId || 'N/A'}, Bet Name: ${bet.betName || 'N/A'}`,
        },
      });

      // Delete the bet
      await tx.bet.delete({
        where: { id: bet.id },
      });
    });

    this.logger.log(
      `Bet ${bet.id} (settlementId: ${bet.settlementId || 'N/A'}) deleted by admin ${adminId}. Refunded ${refundAmount} to user ${bet.userId}`,
    );

    return {
      success: true,
      message: 'Bet deleted successfully',
      data: {
        betId: bet.id,
        settlementId: bet.settlementId,
        userId: bet.userId,
        userName: bet.user.name,
        refundAmount,
      },
    };
  }

  /**
   * Get pending bets for a user
   */
  async getUserPendingBets(userId: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      include: {
        match: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get settled bets for a user (WON, LOST, or CANCELLED)
   */
  async getUserSettledBets(
    userId: string,
    status?: 'WON' | 'LOST' | 'CANCELLED',
  ) {
    const statusFilter = status
      ? ([status] as BetStatus[])
      : [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED];

    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: {
          in: statusFilter,
        },
      },
      include: {
        match: true,
      },
      orderBy: {
        settledAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get all bets for a user with optional status filter
   */
  async getUserBets(userId: string, status?: BetStatus) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        ...(status && { status }),
      },
      include: {
        match: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get all pending bets grouped by match and market type
   * Returns matches with pending fancy, match-odds, and bookmaker bets
   */
  /**
   * Extract selectionId from settlementId format: "{marketId}_{selectionId}"
   * Example: "611629359_49050" -> "49050"
   */
  private getSelectionIdFromSettlementId(settlementId: string): string | null {
    if (!settlementId || !settlementId.includes('_')) {
      return null;
    }
    const parts = settlementId.split('_');
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }

  /**
   * Clean team name by removing market type strings
   */
  private cleanTeamName(teamName: string | null | undefined): string {
    if (!teamName) return '';
    
    // Remove common market type strings
    const marketTypes = ['MATCH_ODDS', 'MATCHODDS', 'FANCY', 'BOOKMAKER', 'BOOK'];
    let cleaned = teamName.trim();
    
    for (const marketType of marketTypes) {
      // Remove exact matches
      if (cleaned.toUpperCase() === marketType) {
        return '';
      }
      // Remove if it's part of the string (case insensitive)
      const regex = new RegExp(`\\b${marketType}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '').trim();
    }
    
    return cleaned;
  }

  /**
   * Get proper match title from bet and match data
   */
  private getMatchTitle(bet: any): string {
    // First priority: eventName from match (usually has the correct format)
    if (bet.match?.eventName) {
      // Clean eventName if it contains market type strings
      const cleanedEventName = this.cleanTeamName(bet.match.eventName);
      if (cleanedEventName && !cleanedEventName.includes('MATCH_ODDS')) {
        return bet.match.eventName;
      }
    }

    // Second priority: Clean homeTeam and awayTeam
    let homeTeam = this.cleanTeamName(bet.match?.homeTeam);
    let awayTeam = this.cleanTeamName(bet.match?.awayTeam);

    // If awayTeam is empty or contains market type, try to extract from betName
    // For match odds, betName often contains the team name
    if (!awayTeam || awayTeam === '' || awayTeam.toUpperCase().includes('MATCH')) {
      // If homeTeam is valid, we might be able to infer awayTeam from context
      // But for now, if we have a valid homeTeam, use it
      if (homeTeam) {
        // Try to get awayTeam from marketName if available
        if (bet.marketName && !bet.marketName.toUpperCase().includes('MATCH_ODDS')) {
          awayTeam = bet.marketName.trim();
        } else {
          // If we can't find awayTeam, just show homeTeam
          return homeTeam;
        }
      }
    }

    // If both teams are valid (not empty after cleaning)
    if (homeTeam && awayTeam && homeTeam !== awayTeam) {
      return `${homeTeam} vs ${awayTeam}`;
    }

    // If only homeTeam is valid
    if (homeTeam && !awayTeam) {
      return homeTeam;
    }

    // Third priority: Try to extract from betName if it contains "vs"
    if (bet.betName && bet.betName.includes(' vs ')) {
      return bet.betName;
    }

    // Fallback: Use original values or defaults
    const finalHomeTeam = homeTeam || bet.match?.homeTeam || 'Team A';
    const finalAwayTeam = awayTeam || bet.match?.awayTeam || 'Team B';
    
    // Only show "vs" if both teams are different and not market types
    if (finalHomeTeam !== finalAwayTeam && 
        !finalHomeTeam.toUpperCase().includes('MATCH') && 
        !finalAwayTeam.toUpperCase().includes('MATCH')) {
      return `${finalHomeTeam} vs ${finalAwayTeam}`;
    }
    
    return finalHomeTeam;
  }

  async getPendingBetsByMatch() {
    // Get all pending bets (don't filter by eventId - we'll handle nulls)
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
      },
      include: {
        match: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Group by matchId (since eventId might be null) and market type
    const matchMap = new Map<
      string,
      {
        eventId: string | null;
        matchId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        fancy: {
          count: number;
          totalAmount: number;
          bets: any[];
        };
        matchOdds: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        bookmaker: {
          count: number;
          totalAmount: number;
          bets: any[];
        };
      }
    >();

    for (const bet of pendingBets) {
      // Use matchId as key if eventId is not available
      const matchKey = bet.eventId || bet.matchId;
      
      const settlementId = bet.settlementId || '';
      let marketType: 'fancy' | 'matchOdds' | 'bookmaker' | null = null;

      // Determine market type from settlementId first
      if (settlementId.startsWith('CRICKET:FANCY:')) {
        marketType = 'fancy';
      } else if (settlementId.startsWith('CRICKET:MATCHODDS:')) {
        marketType = 'matchOdds';
      } else if (settlementId.startsWith('CRICKET:BOOKMAKER:')) {
        marketType = 'bookmaker';
      } else {
        // Fallback to marketType field
        const betMarketType = (bet.marketType || '').toUpperCase();
        if (betMarketType.includes('FANCY') || betMarketType === 'FANCY') {
          marketType = 'fancy';
        } else if (
          (betMarketType.includes('MATCH') && betMarketType.includes('ODD')) ||
          betMarketType === 'MATCH_ODDS' ||
          betMarketType === 'MATCHODDS'
        ) {
          marketType = 'matchOdds';
        } else if (
          betMarketType.includes('BOOKMAKER') ||
          betMarketType.includes('BOOK') ||
          betMarketType === 'BOOKMAKER'
        ) {
          marketType = 'bookmaker';
        } else {
          // Try gtype field as last resort
          const gtype = (bet.gtype || '').toUpperCase();
          if (gtype.includes('FANCY')) {
            marketType = 'fancy';
          } else if (gtype.includes('ODD') || gtype.includes('MATCH')) {
            marketType = 'matchOdds';
          } else if (gtype.includes('BOOK')) {
            marketType = 'bookmaker';
          }
        }
      }

      // If still no market type, skip this bet (or we could add an "unknown" category)
      if (!marketType) {
        this.logger.warn(
          `Could not determine market type for bet ${bet.id}. settlementId: ${settlementId}, marketType: ${bet.marketType}, gtype: ${bet.gtype}`,
        );
        continue;
      }

      // Get or create match entry
      if (!matchMap.has(matchKey)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          fancy: { count: 0, totalAmount: 0, bets: [] },
          matchOdds: { count: 0, totalAmount: 0, bets: [], runners: [] },
          bookmaker: { count: 0, totalAmount: 0, bets: [] },
        });
      }

      const matchData = matchMap.get(matchKey)!;
      const marketData = matchData[marketType];

      marketData.count++;
      marketData.totalAmount += bet.amount || 0;
      marketData.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        marketType: bet.marketType,
        settlementId: bet.settlementId,
        eventId: bet.eventId,
        createdAt: bet.createdAt,
      });

      // For match odds, extract runners from settlementId
      if (marketType === 'matchOdds') {
        const selectionIdStr = this.getSelectionIdFromSettlementId(settlementId);
        if (selectionIdStr) {
          const selectionId = parseInt(selectionIdStr, 10);
          if (!isNaN(selectionId)) {
            // Check if runner already exists
            const existingRunner = matchData.matchOdds.runners.find(
              (r) => r.selectionId === selectionId,
            );
            if (!existingRunner) {
              // Add runner with selectionId and name from betName
              matchData.matchOdds.runners.push({
                selectionId,
                name: bet.betName || `Selection ${selectionId}`,
              });
            }
          }
        }
      }
    }

    // Post-process matches to improve titles by collecting team names from bets
    const processedMatches = Array.from(matchMap.values()).map((match) => {
      // If match title or awayTeam contains "MATCH_ODDS", try to extract from bets
      if (match.matchTitle.includes('MATCH_ODDS') || 
          match.awayTeam.toUpperCase().includes('MATCH_ODDS') ||
          (!match.awayTeam || match.awayTeam === '')) {
        
        // Collect unique team names from match odds bets (excluding "The Draw")
        const teamNames = new Set<string>();
        for (const bet of match.matchOdds.bets) {
          if (bet.betName && 
              bet.betName !== 'The Draw' && 
              !bet.betName.toUpperCase().includes('MATCH') &&
              !bet.betName.toUpperCase().includes('ODDS')) {
            teamNames.add(bet.betName.trim());
          }
        }

        // If we found team names, use them
        if (teamNames.size >= 2) {
          const teams = Array.from(teamNames);
          match.matchTitle = `${teams[0]} vs ${teams[1]}`;
          match.homeTeam = teams[0];
          match.awayTeam = teams[1];
        } else if (teamNames.size === 1 && match.homeTeam && 
                   !match.homeTeam.toUpperCase().includes('MATCH')) {
          // If we have one team from bets and homeTeam is valid, use both
          const teamFromBet = Array.from(teamNames)[0];
          if (teamFromBet !== match.homeTeam) {
            match.matchTitle = `${match.homeTeam} vs ${teamFromBet}`;
            match.awayTeam = teamFromBet;
          }
        } else if (match.homeTeam && !match.homeTeam.toUpperCase().includes('MATCH')) {
          // If only homeTeam is valid, just show it
          match.matchTitle = match.homeTeam;
        }
      }

      return match;
    });

    // Sort by startTime
    const sortedMatches = processedMatches.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      data: sortedMatches,
      totalMatches: sortedMatches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  /**
   * Get all settlements with detailed information
   * Includes bet counts, amounts, and can be filtered
   */
  async getAllSettlements(filters?: {
    eventId?: string;
    marketType?: MarketType;
    isRollback?: boolean;
    settledBy?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};

    if (filters?.eventId) {
      where.eventId = filters.eventId;
    }

    if (filters?.marketType) {
      where.marketType = filters.marketType;
    }

    if (filters?.isRollback !== undefined) {
      where.isRollback = filters.isRollback;
    }

    if (filters?.settledBy) {
      where.settledBy = filters.settledBy;
    }

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const settlements = await this.prisma.settlement.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: filters?.limit || 100,
      skip: filters?.offset || 0,
    });

    // Get detailed information for each settlement
    const settlementsWithDetails = await Promise.all(
      settlements.map(async (settlement) => {
        // Get all bets for this settlement
        const bets = await this.prisma.bet.findMany({
          where: {
            settlementId: settlement.settlementId,
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                username: true,
              },
            },
            match: {
              select: {
                id: true,
                homeTeam: true,
                awayTeam: true,
                eventName: true,
                eventId: true,
              },
            },
          },
        });

        // Calculate statistics
        const totalBets = bets.length;
        const wonBets = bets.filter((b) => b.status === BetStatus.WON).length;
        const lostBets = bets.filter((b) => b.status === BetStatus.LOST).length;
        const cancelledBets = bets.filter(
          (b) => b.status === BetStatus.CANCELLED,
        ).length;

        const totalStake = bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
        const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);
        const totalWinAmount = bets
          .filter((b) => b.status === BetStatus.WON)
          .reduce((sum, bet) => sum + (bet.pnl || 0), 0);
        const totalLossAmount = Math.abs(
          bets
            .filter((b) => b.status === BetStatus.LOST)
            .reduce((sum, bet) => sum + (bet.pnl || 0), 0),
        );

        // Get match info from first bet (they should all have same match)
        const matchInfo = bets[0]?.match || null;

        return {
          id: settlement.id,
          settlementId: settlement.settlementId,
          eventId: settlement.eventId,
          marketType: settlement.marketType,
          marketId: settlement.marketId,
          winnerId: settlement.winnerId,
          settledBy: settlement.settledBy,
          isRollback: settlement.isRollback,
          createdAt: settlement.createdAt,
          match: matchInfo
            ? {
                id: matchInfo.id,
                eventId: matchInfo.eventId,
                eventName: matchInfo.eventName,
                homeTeam: matchInfo.homeTeam,
                awayTeam: matchInfo.awayTeam,
              }
            : null,
          statistics: {
            totalBets,
            wonBets,
            lostBets,
            cancelledBets,
            totalStake,
            totalPnl,
            totalWinAmount,
            totalLossAmount,
          },
          bets: bets.map((bet) => ({
            id: bet.id,
            userId: bet.userId,
            userName: bet.user.name,
            userUsername: bet.user.username,
            amount: bet.amount,
            odds: bet.odds,
            betType: bet.betType,
            betName: bet.betName,
            status: bet.status,
            pnl: bet.pnl,
            settledAt: bet.settledAt,
            rollbackAt: bet.rollbackAt,
            createdAt: bet.createdAt,
          })),
        };
      }),
    );

    // Get total count for pagination
    const totalCount = await this.prisma.settlement.count({ where });

    return {
      success: true,
      data: settlementsWithDetails,
      pagination: {
        total: totalCount,
        limit: filters?.limit || 100,
        offset: filters?.offset || 0,
        hasMore: (filters?.offset || 0) + settlements.length < totalCount,
      },
    };
  }

  /**
   * Get a single settlement by settlementId with full details
   */
  async getSettlementById(settlementId: string) {
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const settlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (!settlement) {
      throw new BadRequestException(`Settlement not found: ${settlementId}`);
    }

    // Get all bets for this settlement
    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId: settlement.settlementId,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
          },
        },
      },
    });

    // Calculate statistics
    const totalBets = bets.length;
    const wonBets = bets.filter((b) => b.status === BetStatus.WON).length;
    const lostBets = bets.filter((b) => b.status === BetStatus.LOST).length;
    const cancelledBets = bets.filter(
      (b) => b.status === BetStatus.CANCELLED,
    ).length;

    const totalStake = bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
    const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);
    const totalWinAmount = bets
      .filter((b) => b.status === BetStatus.WON)
      .reduce((sum, bet) => sum + (bet.pnl || 0), 0);
    const totalLossAmount = Math.abs(
      bets
        .filter((b) => b.status === BetStatus.LOST)
        .reduce((sum, bet) => sum + (bet.pnl || 0), 0),
    );

    const matchInfo = bets[0]?.match || null;

    return {
      success: true,
      data: {
        id: settlement.id,
        settlementId: settlement.settlementId,
        eventId: settlement.eventId,
        marketType: settlement.marketType,
        marketId: settlement.marketId,
        winnerId: settlement.winnerId,
        settledBy: settlement.settledBy,
        isRollback: settlement.isRollback,
        createdAt: settlement.createdAt,
        match: matchInfo
          ? {
              id: matchInfo.id,
              eventId: matchInfo.eventId,
              eventName: matchInfo.eventName,
              homeTeam: matchInfo.homeTeam,
              awayTeam: matchInfo.awayTeam,
            }
          : null,
        statistics: {
          totalBets,
          wonBets,
          lostBets,
          cancelledBets,
          totalStake,
          totalPnl,
          totalWinAmount,
          totalLossAmount,
        },
        bets: bets.map((bet) => ({
          id: bet.id,
          userId: bet.userId,
          userName: bet.user.name,
          userUsername: bet.user.username,
          amount: bet.amount,
          odds: bet.odds,
          betType: bet.betType,
          betName: bet.betName,
          status: bet.status,
          pnl: bet.pnl,
          settledAt: bet.settledAt,
          rollbackAt: bet.rollbackAt,
          createdAt: bet.createdAt,
        })),
      },
    };
  }

  /**
   * Get pending bets for a specific market type
   */
  async getPendingBetsByMarketType(marketType: 'fancy' | 'match-odds' | 'bookmaker') {
    const settlementPrefix =
      marketType === 'fancy'
        ? 'CRICKET:FANCY:'
        : marketType === 'match-odds'
          ? 'CRICKET:MATCHODDS:'
          : 'CRICKET:BOOKMAKER:';

    const pendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        settlementId: {
          startsWith: settlementPrefix,
        },
        eventId: {
          not: null,
        },
      },
      include: {
        match: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Group by eventId
    const matchMap = new Map<
      string,
      {
        eventId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        bets: any[];
        totalAmount: number;
      }
    >();

    for (const bet of pendingBets) {
      if (!bet.eventId) continue;

      if (!matchMap.has(bet.eventId)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(bet.eventId, {
          eventId: bet.eventId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          bets: [],
          totalAmount: 0,
        });
      }

      const matchData = matchMap.get(bet.eventId)!;
      matchData.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        settlementId: bet.settlementId,
        createdAt: bet.createdAt,
      });
      matchData.totalAmount += bet.amount || 0;
    }

    const matches = Array.from(matchMap.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      marketType,
      data: matches,
      totalMatches: matches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  @Cron('*/15 * * * * *') // every 15 seconds
  async handleFancySettlement() {
    try {
      // Check if bets table exists first (to avoid errors during initial setup)
      try {
        await this.prisma.$queryRaw`SELECT 1 FROM "bets" LIMIT 1`;
      } catch (error: any) {
        // If table doesn't exist, skip this cron run
        if (error.message?.includes('does not exist') || error.code === '42P01') {
          // Table doesn't exist yet - skip silently (only log once)
          if (!this.loggedTableMissing) {
            this.logger.warn('Bets table does not exist yet. Skipping settlement cron. Run SQL schema in Supabase SQL Editor.');
            this.loggedTableMissing = true;
          }
          return;
        }
        throw error; // Re-throw if it's a different error
      }
      
      // Get all unique eventIds that have pending fancy bets
      const pendingFancyBets = await this.prisma.bet.findMany({
        where: {
          status: BetStatus.PENDING,
          settlementId: {
            startsWith: 'CRICKET:FANCY:',
          },
          eventId: {
            not: null,
          },
        },
      select: {
        eventId: true,
      },
    });

      // Get unique eventIds using Set
      const eventIds = Array.from(
        new Set(
          pendingFancyBets
            .map((bet) => bet.eventId)
            .filter((id): id is string => id !== null && id !== undefined),
        ),
      );

      for (const eventId of eventIds) {
        try {
          await this.settleFancyAuto(eventId);
        } catch (error) {
          this.logger.error(
            `Failed to settle fancy bets for eventId ${eventId}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Error in handleFancySettlement: ${(error as Error).message}`,
      );
    }
  }
}
