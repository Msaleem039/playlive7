import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BetStatus, PrismaClient } from '@prisma/client';
// @ts-ignore - MarketType exists after Prisma client regeneration
import { MarketType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CricketIdService } from '../cricketid/cricketid.service';
import { PnlService } from './pnl.service';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cricketIdService: CricketIdService,
    private readonly pnlService: PnlService,
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
      } catch (error) {
          this.logger.warn(
            `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
          );
        }
      }
    }
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

    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
      },
    });

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

    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
      },
    });

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
      } catch (error) {
        this.logger.warn(
          `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
        );
      }
    }

    return { success: true, message: 'Match odds bets settled successfully' };
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

    return { success: true, message: 'Settlement rolled back successfully' };
  }

  @Cron('*/15 * * * * *') // every 15 seconds
  async handleFancySettlement() {
    try {
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
