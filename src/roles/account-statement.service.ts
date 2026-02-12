import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionType, TransferLogType, BetStatus } from '@prisma/client';

/**
 * Account Statement Service
 * 
 * Provides comprehensive account statement with:
 * - Cash transactions (CashIn/CashOut)
 * - Match settlements (Profit/Loss)
 * - Market Commission
 * - Session Profit/Loss
 * - Toss Profit/Loss
 * 
 * All entries sorted by date with running balance calculation.
 */

export interface StatementEntry {
  id: string;
  date: Date;
  type: 'MATCH' | 'CashIn' | 'CashOut' | 'SESSION' | 'COMMISSION' | 'TOSS';
  description: string;
  result: string | null;
  credit: number;
  debit: number;
  balance: number;
  settlementId?: string | null;
  eventId?: string | null;
  marketId?: string | null;
  hasBets: boolean;
}

export interface AccountStatementResult {
  userId: string;
  userName: string | null;
  openingBalance: number;
  closingBalance: number;
  totalEntries: number;
  entries: StatementEntry[];
}

export interface AccountStatementFilters {
  showCashEntry?: boolean;
  showMarketPnl?: boolean;
  showMarketCommission?: boolean;
  showSessionPnl?: boolean;
  showTossPnl?: boolean;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AccountStatementService {
  private readonly logger = new Logger(AccountStatementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get comprehensive account statement for a user
   */
  async getAccountStatement(
    userId: string,
    filters: AccountStatementFilters = {},
  ): Promise<AccountStatementResult> {
    const {
      showCashEntry = true,
      showMarketPnl = true,
      showMarketCommission = false,
      showSessionPnl = false,
      showTossPnl = false,
      fromDate,
      toDate,
      limit = 1000,
      offset = 0,
    } = filters;

    // Get user and wallet
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        username: true,
        wallet: {
          select: {
            balance: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const currentBalance = user.wallet?.balance || 0;
    const allEntries: StatementEntry[] = [];

    // 1️⃣ Get Cash Transactions (TransferLogs)
    if (showCashEntry) {
      const transferLogs = await this.prisma.transferLog.findMany({
        where: {
          OR: [
            { fromUserId: userId, type: TransferLogType.TOPDOWN },
            { toUserId: userId, type: TransferLogType.TOPUP },
          ],
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });

      for (const log of transferLogs) {
        const isCashIn = log.type === TransferLogType.TOPUP && log.toUserId === userId;
        const isCashOut = log.type === TransferLogType.TOPDOWN && log.fromUserId === userId;

        if (isCashIn) {
          allEntries.push({
            id: log.id,
            date: log.createdAt,
            type: 'CashIn',
            description: `CashIn To ${log.remarks || ''}`.trim(),
            result: null,
            credit: log.amount,
            debit: 0,
            balance: 0, // Will be calculated later
            hasBets: false,
          });
        } else if (isCashOut) {
          allEntries.push({
            id: log.id,
            date: log.createdAt,
            type: 'CashOut',
            description: `CashOut From ${log.remarks || ''}`.trim(),
            result: null,
            credit: 0,
            debit: log.amount,
            balance: 0, // Will be calculated later
            hasBets: false,
          });
        }
      }
    }

    // 2️⃣ Get Match Settlements (from settled bets) - Group by eventId (match-wise)
    if (showMarketPnl) {
      const settledBets = await this.prisma.bet.findMany({
        where: {
          userId,
          status: { in: [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED] },
          settlementId: { not: null },
          eventId: { not: null },
          ...(fromDate || toDate
            ? {
                settledAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        select: {
          id: true,
          settlementId: true,
          eventId: true,
          marketId: true,
          betName: true,
          marketName: true,
          status: true,
          pnl: true,
          settledAt: true,
          match: {
            select: {
              eventName: true,
              homeTeam: true,
              awayTeam: true,
            },
          },
        },
        orderBy: { settledAt: 'desc' },
      });

      // Group by eventId to show one entry per match
      const betsByEventId = new Map<string, typeof settledBets>();
      for (const bet of settledBets) {
        if (bet.eventId) {
          if (!betsByEventId.has(bet.eventId)) {
            betsByEventId.set(bet.eventId, []);
          }
          betsByEventId.get(bet.eventId)!.push(bet);
        }
      }

      for (const [eventId, bets] of betsByEventId.entries()) {
        if (bets.length === 0) continue;

        // Get the most recent settlement date for this match
        const latestBet = bets.reduce((latest, bet) => {
          const betDate = bet.settledAt || new Date(0);
          const latestDate = latest.settledAt || new Date(0);
          return betDate > latestDate ? bet : latest;
        }, bets[0]);

        // Calculate total profit/loss for this match
        const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);

        // Get match name from first bet
        const firstBet = bets[0];
        const matchName =
          firstBet.match?.eventName ||
          `${firstBet.match?.homeTeam || ''} v ${firstBet.match?.awayTeam || ''}`.trim() ||
          'Match';

        // Determine result (use the most common result or latest)
        let result: string | null = null;
        const resultCounts = new Map<string, number>();
        for (const bet of bets) {
          if (bet.betName) {
            resultCounts.set(bet.betName, (resultCounts.get(bet.betName) || 0) + 1);
          }
        }
        if (resultCounts.size > 0) {
          const sortedResults = Array.from(resultCounts.entries()).sort((a, b) => b[1] - a[1]);
          result = sortedResults[0][0];
        } else {
          result = latestBet.betName || 'Settled';
        }

        const description = `Cricket/${matchName} : Match COM 0.00`;

        allEntries.push({
          id: `match_${eventId}`,
          date: latestBet.settledAt || new Date(),
          type: 'MATCH',
          description,
          result,
          credit: totalPnl > 0 ? totalPnl : 0,
          debit: totalPnl < 0 ? Math.abs(totalPnl) : 0,
          balance: 0, // Will be calculated later
          settlementId: null,
          eventId: eventId,
          marketId: null,
          hasBets: false,
        });
      }
    }

    // 3️⃣ Get Market Commission (from HierarchyPnl)
    if (showMarketCommission) {
      const commissions = await this.prisma.hierarchyPnl.findMany({
        where: {
          toUserId: userId,
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });

      for (const commission of commissions) {
        allEntries.push({
          id: commission.id,
          date: commission.createdAt,
          type: 'COMMISSION',
          description: `Market Commission - ${commission.marketType}`,
          result: null,
          credit: commission.amount,
          debit: 0,
          balance: 0,
          eventId: commission.eventId,
          hasBets: false,
        });
      }
    }

    // 4️⃣ Get Session Profit/Loss (if exists - could be from UserPnl with specific market type)
    if (showSessionPnl) {
      const sessionPnls = await this.prisma.userPnl.findMany({
        where: {
          userId,
          // Assuming session is tracked via a specific market type or event
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });

      for (const pnl of sessionPnls) {
        if (pnl.netPnl !== 0) {
          allEntries.push({
            id: pnl.id,
            date: pnl.createdAt,
            type: 'SESSION',
            description: `Cricket/OLd Profit loss`,
            result: 'R1', // Session result identifier
            credit: pnl.netPnl > 0 ? pnl.netPnl : 0,
            debit: pnl.netPnl < 0 ? Math.abs(pnl.netPnl) : 0,
            balance: 0,
            eventId: pnl.eventId,
            hasBets: false,
          });
        }
      }
    }

    // 5️⃣ Get Toss Profit/Loss (similar to session, could be from specific market type)
    if (showTossPnl) {
      // Toss PnL would be similar to session - could be from UserPnl with marketType = 'TOSS'
      // For now, we'll check if there are any bets with marketName containing 'Toss'
      const tossBets = await this.prisma.bet.findMany({
        where: {
          userId,
          marketName: { contains: 'Toss', mode: 'insensitive' },
          status: { in: [BetStatus.WON, BetStatus.LOST] },
          ...(fromDate || toDate
            ? {
                settledAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        select: {
          id: true,
          settlementId: true,
          eventId: true,
          betName: true,
          pnl: true,
          settledAt: true,
        },
        orderBy: { settledAt: 'desc' },
        take: limit,
        skip: offset,
      });

      // Group by settlementId
      const tossBySettlement = new Map<string, typeof tossBets>();
      for (const bet of tossBets) {
        if (bet.settlementId) {
          if (!tossBySettlement.has(bet.settlementId)) {
            tossBySettlement.set(bet.settlementId, []);
          }
          tossBySettlement.get(bet.settlementId)!.push(bet);
        }
      }

      for (const [settlementId, bets] of tossBySettlement.entries()) {
        const firstBet = bets[0];
        const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);

        allEntries.push({
          id: settlementId,
          date: firstBet.settledAt || new Date(),
          type: 'TOSS',
          description: `Cricket/Toss Profit Loss`,
          result: firstBet.betName || 'Toss',
          credit: totalPnl > 0 ? totalPnl : 0,
          debit: totalPnl < 0 ? Math.abs(totalPnl) : 0,
          balance: 0,
          settlementId,
          eventId: firstBet.eventId,
          hasBets: false,
        });
      }
    }

    // 6️⃣ Sort all entries by date (newest first)
    allEntries.sort((a, b) => b.date.getTime() - a.date.getTime());

    // 7️⃣ Calculate running balance (from newest to oldest, then reverse)
    // We need to work backwards from current balance
    let runningBalance = currentBalance;
    const entriesWithBalance: StatementEntry[] = [];

    // Reverse to calculate from oldest to newest
    const reversedEntries = [...allEntries].reverse();

    for (const entry of reversedEntries) {
      // Adjust balance based on credit/debit
      runningBalance = runningBalance - entry.credit + entry.debit;
      entriesWithBalance.push({
        ...entry,
        balance: runningBalance,
      });
    }

    // Reverse back to newest first
    entriesWithBalance.reverse();

    // 8️⃣ Calculate opening balance (oldest entry balance)
    const openingBalance =
      entriesWithBalance.length > 0
        ? entriesWithBalance[entriesWithBalance.length - 1].balance
        : currentBalance;

    return {
      userId: user.id,
      userName: user.name || user.username,
      openingBalance,
      closingBalance: currentBalance,
      totalEntries: entriesWithBalance.length,
      entries: entriesWithBalance,
    };
  }
}

