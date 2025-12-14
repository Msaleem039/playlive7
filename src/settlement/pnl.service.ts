import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus } from '@prisma/client';
// @ts-ignore - MarketType exists after Prisma client regeneration
import { MarketType } from '@prisma/client';

@Injectable()
export class PnlService {
  private readonly logger = new Logger(PnlService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Map bet marketType string to MarketType enum
   */
  private mapMarketType(marketType: string | null | undefined): MarketType | null {
    if (!marketType) return null;

    const upper = marketType.toUpperCase();
    if (upper.includes('FANCY')) return MarketType.FANCY;
    if (upper.includes('BOOKMAKER')) return MarketType.BOOKMAKER;
    if (upper.includes('MATCH') && upper.includes('ODD')) return MarketType.MATCH_ODDS;
    
    // Default mapping based on common patterns
    if (upper === 'FANCY' || upper === 'FANCY1') return MarketType.FANCY;
    if (upper === 'BOOKMAKER' || upper === 'BOOK') return MarketType.BOOKMAKER;
    if (upper === 'MATCH_ODDS' || upper === 'MATCHODDS') return MarketType.MATCH_ODDS;

    return null;
  }

  /**
   * Calculate P/L for a single user for a specific event
   * Groups by marketType
   */
  async calculateUserPnl(userId: string, eventId: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        eventId,
        status: {
          in: [BetStatus.WON, BetStatus.LOST],
        },
      },
    });

    const pnlByMarket: Record<string, { profit: number; loss: number }> = {};

    for (const bet of bets) {
      const marketType = this.mapMarketType(bet.marketType);
      if (!marketType) {
        this.logger.warn(
          `Skipping bet ${bet.id} - unknown marketType: ${bet.marketType}`,
        );
        continue;
      }

      const marketKey = marketType;
      if (!pnlByMarket[marketKey]) {
        pnlByMarket[marketKey] = { profit: 0, loss: 0 };
      }

      if (bet.status === BetStatus.WON) {
        // Profit = winAmount (what user gains)
        // @ts-ignore - pnl field exists after database migration
        const profit = bet.winAmount ?? bet.pnl ?? 0;
        pnlByMarket[marketKey].profit += profit;
      } else if (bet.status === BetStatus.LOST) {
        // Loss = lossAmount (what user loses)
        // @ts-ignore - pnl field exists after database migration
        const loss = bet.lossAmount ?? Math.abs(bet.pnl) ?? 0;
        pnlByMarket[marketKey].loss += loss;
      }
    }

    // Save per market
    for (const [marketTypeStr, { profit, loss }] of Object.entries(pnlByMarket)) {
      const marketType = marketTypeStr as MarketType;
      const netPnl = profit - loss;

      // @ts-ignore - userPnl property exists after Prisma client regeneration
      await this.prisma.userPnl.upsert({
        where: {
          userId_eventId_marketType: {
            userId,
            eventId,
            marketType,
          },
        },
        update: {
          profit,
          loss,
          netPnl,
          updatedAt: new Date(),
        },
        create: {
          userId,
          eventId,
          marketType,
          profit,
          loss,
          netPnl,
        },
      });
    }

    return pnlByMarket;
  }

  /**
   * Aggregate P/L for all users for an event
   */
  async calculateEventPnl(eventId: string) {
    const users = await this.prisma.bet.findMany({
      where: {
        eventId,
        status: {
          in: [BetStatus.WON, BetStatus.LOST],
        },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    const results: Record<string, any> = {};

    for (const { userId } of users) {
      try {
        results[userId] = await this.calculateUserPnl(userId, eventId);
      } catch (error) {
        this.logger.error(
          `Failed to calculate P/L for user ${userId} in event ${eventId}: ${(error as Error).message}`,
        );
      }
    }

    return results;
  }

  /**
   * Get P/L summary for a user across all events
   */
  async getUserPnlSummary(userId: string) {
    // @ts-ignore - userPnl property exists after Prisma client regeneration
    const userPnlRecords = await this.prisma.userPnl.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    const summary = {
      totalProfit: 0,
      totalLoss: 0,
      totalNetPnl: 0,
      byMarketType: {} as Record<MarketType, { profit: number; loss: number; netPnl: number }>,
      byEvent: {} as Record<string, { profit: number; loss: number; netPnl: number }>,
    };

    for (const record of userPnlRecords) {
      summary.totalProfit += record.profit;
      summary.totalLoss += record.loss;
      summary.totalNetPnl += record.netPnl;

      // Group by market type
      if (!summary.byMarketType[record.marketType]) {
        summary.byMarketType[record.marketType] = {
          profit: 0,
          loss: 0,
          netPnl: 0,
        };
      }
      summary.byMarketType[record.marketType].profit += record.profit;
      summary.byMarketType[record.marketType].loss += record.loss;
      summary.byMarketType[record.marketType].netPnl += record.netPnl;

      // Group by event
      if (!summary.byEvent[record.eventId]) {
        summary.byEvent[record.eventId] = {
          profit: 0,
          loss: 0,
          netPnl: 0,
        };
      }
      summary.byEvent[record.eventId].profit += record.profit;
      summary.byEvent[record.eventId].loss += record.loss;
      summary.byEvent[record.eventId].netPnl += record.netPnl;
    }

    return summary;
  }

  /**
   * Recalculate P/L for a user after settlement
   * Call this after settling bets
   */
  async recalculateUserPnlAfterSettlement(
    userId: string,
    eventId: string,
  ) {
    return this.calculateUserPnl(userId, eventId);
  }
}

