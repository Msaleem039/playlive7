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
        const matchTitle =
          bet.match?.eventName ||
          `${bet.match?.homeTeam || 'Team A'} vs ${bet.match?.awayTeam || 'Team B'}`;

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam: bet.match?.homeTeam || '',
          awayTeam: bet.match?.awayTeam || '',
          startTime: bet.match?.startTime || new Date(),
          fancy: { count: 0, totalAmount: 0, bets: [] },
          matchOdds: { count: 0, totalAmount: 0, bets: [] },
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
    }

    // Convert map to array and sort by startTime
    const matches = Array.from(matchMap.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      data: matches,
      totalMatches: matches.length,
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
        const matchTitle =
          bet.match?.eventName ||
          `${bet.match?.homeTeam || 'Team A'} vs ${bet.match?.awayTeam || 'Team B'}`;

        matchMap.set(bet.eventId, {
          eventId: bet.eventId,
          matchTitle,
          homeTeam: bet.match?.homeTeam || '',
          awayTeam: bet.match?.awayTeam || '',
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
