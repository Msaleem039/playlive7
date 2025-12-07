import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { URLSearchParams } from 'url';
import {
  BetStatus,
  MatchStatus,
  Prisma,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type SettlementResult = {
  success: boolean;
  settlement_id?: string;
  match_id?: string;
  message?: string;
  settled?: Array<{
    betId: string;
    userId: string;
    result: 'won' | 'lost';
    profitLoss: number;
  }>;
};

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private readonly baseUrl = 'https://api.cricketid.xyz';
  private readonly apiKey =
    process.env.CRICKET_ID_API_KEY ?? 'dijbfuwd719e12rqhfbjdqdnkqnd11';
  private readonly apiSid = process.env.CRICKET_ID_API_SID ?? '4';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Settle bets by settlement_id (match_id + selection_id)
   * This matches the PHP logic where settlement_id = match_id + "_" + selection_id
   */
  async settleBySettlementId(settlementId: string): Promise<SettlementResult> {
    if (!settlementId) {
      return { success: false, message: 'settlement_id is required' };
    }

    const pendingBets = await this.getPendingBetsBySettlementId(settlementId);
    if (pendingBets.length === 0) {
      return {
        success: true,
        settlement_id: settlementId,
        message: 'No pending bets to settle for this settlement_id.',
      };
    }

    // Get match_id from the first bet (all bets with same settlement_id share same match_id)
    const matchId = pendingBets[0].matchId;
    if (!matchId) {
      return {
        success: false,
        settlement_id: settlementId,
        message: 'Match ID not found in bets.',
      };
    }

    // Use the first bet as reference for fetching result
    const referenceBet = pendingBets[0];
    const matchResult = await this.fetchMatchResult(matchId, referenceBet);

    if (!matchResult) {
      return {
        success: false,
        settlement_id: settlementId,
        match_id: matchId,
        message: 'Unable to fetch result from provider.',
      };
    }

    if (!matchResult.winner) {
      return {
        success: false,
        settlement_id: settlementId,
        match_id: matchId,
        message: 'Result not ready yet.',
      };
    }

    this.logger.log(
      `Settling ${pendingBets.length} bets for settlement_id ${settlementId} (match: ${matchId}) with winner: ${matchResult.winner}`,
    );

    return this.processSettlement(settlementId, matchId, pendingBets, matchResult.winner);
  }

  /**
   * Manually settle bets by settlement_id with a manually provided winner/result
   * This allows admins to input the result directly instead of fetching from API
   */
  async settleBySettlementIdWithManualResult(
    settlementId: string,
    winner: string,
  ): Promise<SettlementResult> {
    if (!settlementId) {
      return { success: false, message: 'settlement_id is required' };
    }

    if (!winner) {
      return { success: false, message: 'winner/result is required' };
    }

    const pendingBets = await this.getPendingBetsBySettlementId(settlementId);
    if (pendingBets.length === 0) {
      return {
        success: true,
        settlement_id: settlementId,
        message: 'No pending bets to settle for this settlement_id.',
      };
    }

    const matchId = pendingBets[0].matchId;
    if (!matchId) {
      return {
        success: false,
        settlement_id: settlementId,
        message: 'Match ID not found in bets.',
      };
    }

    this.logger.log(
      `Manually settling ${pendingBets.length} bets for settlement_id ${settlementId} (match: ${matchId}) with manually provided winner: ${winner}`,
    );

    return this.processSettlement(settlementId, matchId, pendingBets, winner);
  }

  /**
   * Settle single session bet by match_id, selection_id, gtype, bet_name
   * Similar to PHP's settleSingleSessionBet()
   * 
   * @param matchId - Match ID
   * @param selectionId - Selection ID
   * @param gtype - Game type (fancy1, Normal, oddeven)
   * @param betName - Bet name
   * @param winnerId - Winner ID (numeric value for comparison)
   */
  async settleSingleSessionBet(
    matchId: string,
    selectionId: number,
    gtype: string,
    betName: string,
    winnerId: number,
  ): Promise<SettlementResult> {
    if (!matchId || !gtype || !betName || winnerId === undefined || winnerId === null) {
      return {
        success: false,
        message: 'match_id, selection_id, gtype, bet_name, and winner_id are required',
      };
    }

    // Get all matching pending bets (like PHP code)
    const bets = await this.prisma.bet.findMany({
      where: {
        matchId,
        selectionId,
        gtype,
        betName: betName.trim(),
        status: BetStatus.PENDING,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (bets.length === 0) {
      return {
        success: false,
        message: 'No pending bets found to settle.',
      };
    }

    this.logger.log(
      `Settling ${bets.length} session bets for match ${matchId}, selection ${selectionId}, gtype ${gtype}, bet_name ${betName} with winner_id: ${winnerId}`,
    );

    // Process settlement with winner_id as string (determineOutcome will handle numeric comparison)
    return this.processSettlement(
      `session_${matchId}_${selectionId}_${gtype}_${betName}`,
      matchId,
      bets,
      winnerId.toString(),
    );
  }

  /**
   * Common settlement processing logic
   * This handles the actual settlement of bets with a given winner
   */
  private async processSettlement(
    settlementId: string,
    matchId: string,
    pendingBets: any[],
    winner: string,
  ): Promise<SettlementResult> {
    // Increase transaction timeout to 60 seconds for settlement operations
    // Settlement involves multiple wallet updates and can take longer
    const settled = await this.prisma.$transaction(
      async (tx) => {
      const summary: SettlementResult['settled'] = [];

      for (const bet of pendingBets) {
        const outcome = this.determineOutcome(bet, winner);
        if (!outcome) {
          this.logger.warn(
            `Skipping bet ${bet.id} because the outcome could not be determined`,
          );
          continue;
        }

        await tx.bet.update({
          where: { id: bet.id },
          data: {
            status: outcome.status === 'won' ? BetStatus.WON : BetStatus.LOST,
            updatedAt: new Date(),
          },
        });

        await this.applyWalletMutation(
          tx,
          bet.userId,
          outcome.profitLoss,
          bet.id,
          matchId,
          outcome.status,
        );

        summary?.push({
          betId: bet.id,
          userId: bet.userId,
          result: outcome.status,
          profitLoss: outcome.profitLoss,
        });
      }

      // Check if all bets for this match are settled, then mark match as finished
      const remainingPendingBets = await tx.bet.count({
        where: {
          matchId,
          status: BetStatus.PENDING,
        },
      });

      if (remainingPendingBets === 0) {
        await tx.match.updateMany({
          where: { id: matchId },
          data: {
            status: MatchStatus.FINISHED,
            updatedAt: new Date(),
          },
        });
      }

      return summary ?? [];
      },
      {
        maxWait: 60000, // Maximum time to wait for a transaction slot (60 seconds)
        timeout: 60000, // Maximum time the transaction can run (60 seconds)
      },
    );

    return {
      success: true,
      settlement_id: settlementId,
      match_id: matchId,
      settled,
    };
  }

  /**
   * Legacy method - settle all bets for a match
   * This is kept for backward compatibility but internally groups by settlement_id
   */
  async settleMatch(matchId: string): Promise<SettlementResult> {
    if (!matchId) {
      return { success: false, message: 'match_id is required' };
    }

    // Get all unique settlement_ids for this match
    const settlementIds = await this.getSettlementIdsForMatch(matchId);

    if (settlementIds.length === 0) {
      return {
        success: true,
        match_id: matchId,
        message: 'No pending bets to settle.',
      };
    }

    const allSettled: SettlementResult['settled'] = [];
    let hasErrors = false;

    // Settle each settlement_id separately
    for (const settlementId of settlementIds) {
      try {
        const result = await this.settleBySettlementId(settlementId);
        if (result.success && result.settled) {
          allSettled.push(...result.settled);
        } else {
          hasErrors = true;
        }
      } catch (error) {
        this.logger.error(
          `Failed to settle settlement_id ${settlementId} for match ${matchId}: ${(error as Error).message}`,
        );
        hasErrors = true;
      }
    }

    return {
      success: !hasErrors,
      match_id: matchId,
      settled: allSettled,
      message: hasErrors
        ? 'Some settlements completed with errors'
        : 'All settlements completed successfully',
    };
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async autoSettlementCron() {
    const settlementIds = await this.getSettlementIdsAwaitingSettlement();
    if (settlementIds.length === 0) {
      return;
    }

    this.logger.log(
      `Auto settlement triggered for ${settlementIds.length} settlement_id(s): ${settlementIds.slice(0, 5).join(', ')}${settlementIds.length > 5 ? '...' : ''}`,
    );

    for (const settlementId of settlementIds) {
      try {
        await this.settleBySettlementId(settlementId);
      } catch (error) {
        this.logger.error(
          `Failed to auto-settle settlement_id ${settlementId}`,
          (error as Error).stack,
        );
      }
    }
  }

  /**
   * Get pending bets grouped by settlement_id
   */
  private async getPendingBetsBySettlementId(settlementId: string) {
    return this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get all settlement_ids that have pending bets
   * Only includes matches that are FINISHED or LIVE
   */
  private async getSettlementIdsAwaitingSettlement(): Promise<string[]> {
    const bets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        settlementId: { not: null },
        match: {
          status: {
            in: [MatchStatus.FINISHED, MatchStatus.LIVE],
          },
        },
      },
      select: { settlementId: true },
      distinct: ['settlementId'],
      take: 25,
    });

    return bets
      .map((bet) => bet.settlementId)
      .filter((id): id is string => id !== null && id !== undefined);
  }

  /**
   * Get all settlement_ids for a specific match
   */
  private async getSettlementIdsForMatch(matchId: string): Promise<string[]> {
    const bets = await this.prisma.bet.findMany({
      where: {
        matchId,
        status: BetStatus.PENDING,
        settlementId: { not: null },
      },
      select: { settlementId: true },
      distinct: ['settlementId'],
    });

    return bets
      .map((bet) => bet.settlementId)
      .filter((id): id is string => id !== null && id !== undefined);
  }

  /**
   * Legacy method - kept for backward compatibility
   */
  private async getPendingBets(matchId: string) {
    return this.prisma.bet.findMany({
      where: {
        matchId,
        status: BetStatus.PENDING,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Legacy method - kept for backward compatibility
   */
  private async getMatchesAwaitingSettlement(): Promise<string[]> {
    // Only get matches that are FINISHED or LIVE (not UPCOMING)
    // and have pending bets
    const matches = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        match: {
          status: {
            in: [MatchStatus.FINISHED, MatchStatus.LIVE],
          },
        },
      },
      select: { matchId: true },
      distinct: ['matchId'],
      take: 25,
    });

    return matches.map((item) => item.matchId);
  }

  /**
   * Fetch match result from CricketID API
   * Updated to match PHP code structure and use bet-specific data
   */
  private async fetchMatchResult(matchId: string, referenceBet?: any) {
    const matchDetails = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        homeTeam: true,
        awayTeam: true,
        eventId: true,
        eventName: true,
        marketId: true,
        marketName: true,
      } as any,
    });

    // Build payload matching PHP code structure
    // PHP uses: event_id, event_name, market_id, market_name, market_type
    const payload = {
      // In PHP, event_id is the original match_id from the provider.
      // Here we prioritise the bet's matchId, then the match's stored eventId, then fallback to our local matchId.
      event_id: Number(
        referenceBet?.matchId ?? matchDetails?.eventId ?? matchId,
      ),
      event_name:
        matchDetails?.eventName ??
        (matchDetails?.homeTeam && matchDetails?.awayTeam
          ? `${matchDetails.homeTeam} vs ${matchDetails.awayTeam}`
          : referenceBet?.marketName ?? referenceBet?.betName ?? 'Unknown Event'),
      // Critical: for CricketID result API, market_id should match the selid we sent when placing the bet.
      // We now store that as Bet.selId, so use that first, then fall back to any stored marketId/selectionId.
      market_id: Number(
        referenceBet?.selId ??
          matchDetails?.marketId ??
          referenceBet?.selectionId ??
          referenceBet?.marketId ??
          matchId,
      ),
      market_name:
        matchDetails?.marketName ??
        referenceBet?.marketName ??
        referenceBet?.betName ??
        'MATCH_ODDS',
      // Add market_type if available from bet data
      ...(referenceBet?.gtype && { market_type: referenceBet.gtype }),
    };

    const params = new URLSearchParams({
      key: this.apiKey,
      sid: this.apiSid,
    });

    const url = `${this.baseUrl}/get-result?${params.toString()}`;

    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000, // 10 second timeout
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        const errorMessage =
          errorData?.message || JSON.stringify(errorData) || 'Unknown error';

        // If result is not declared yet, it's an expected scenario - log at debug level
        if (
          error.response?.status === 400 &&
          (errorMessage.includes('result is not declared yet') ||
            errorMessage.includes('result is not declared'))
        ) {
          this.logger.debug(
            `Result not available yet for settlement_id ${referenceBet?.settlementId || matchId} - this is expected if the match just finished`,
          );
        } else {
          // Other errors should be logged as errors
          this.logger.error(
            `Failed to fetch result for match ${matchId} (settlement_id: ${referenceBet?.settlementId || 'N/A'}) - Status: ${error.response?.status} - Data: ${JSON.stringify(errorData)}`,
          );
        }
      } else {
        this.logger.error(
          `Failed to fetch result for match ${matchId} - Unknown error: ${(error as Error).stack}`,
        );
      }
      return null;
    }
  }

  private determineOutcome(bet: any, winner: string) {
    const winAmount =
      Number(bet.win_amount ?? bet.winAmount ?? bet.amount * bet.odds) || 0;
    const lossAmount =
      Number(bet.loss_amount ?? bet.lossAmount ?? bet.amount) || 0;

    const winnerId = Number(winner);

    // For session bets (fancy, fancy1, etc.), compare selectionId with winner_id
    // This is the primary comparison method for session bets
    if (!isNaN(winnerId) && bet.selectionId !== null && bet.selectionId !== undefined) {
      const betSelectionId = Number(bet.selectionId);
      if (!isNaN(betSelectionId)) {
        // If selectionId matches winner_id, bet won
        if (betSelectionId === winnerId) {
          return { status: 'won' as const, profitLoss: winAmount };
        } else {
          return { status: 'lost' as const, profitLoss: -lossAmount };
        }
      }
    }

    // Handle back/lay bet types with numeric comparison (like PHP code)
    const betType = bet.bet_type ?? bet.betType;
    const betValue = Number(bet.bet_value ?? bet.betValue ?? 0);

    // If bet has betType and betValue, use numeric comparison logic
    if (betType && betValue > 0 && !isNaN(winnerId)) {
      let isWinner = false;

      if (betType.toLowerCase() === 'back') {
        // Back bet: winner if winner_id >= bet_value
        isWinner = winnerId >= betValue;
      } else if (betType.toLowerCase() === 'lay') {
        // Lay bet: winner if winner_id < bet_value
        isWinner = winnerId < betValue;
      }

      if (isWinner) {
        return { status: 'won' as const, profitLoss: winAmount };
      } else {
        return { status: 'lost' as const, profitLoss: -lossAmount };
      }
    }

    // Fallback to string comparison for other bet types
    const betSelection =
      bet.bet_name ??
      bet.betName ??
      bet.selection ??
      bet.selectionName ??
      bet.market_name ??
      bet.marketName ??
      null;

    if (!betSelection) {
      return null;
    }

    // Compare bet selection with winner (case-insensitive)
    if (betSelection.toString().trim().toLowerCase() === winner.toString().trim().toLowerCase()) {
      return { status: 'won' as const, profitLoss: winAmount };
    }

    return { status: 'lost' as const, profitLoss: -lossAmount };
  }

  private async applyWalletMutation(
    tx: Prisma.TransactionClient,
    userId: string,
    profitLoss: number,
    betId: string,
    matchId: string,
    outcome: 'won' | 'lost',
  ) {
    // CPL = Client Profit/Loss (positive = client loses, negative = client wins)
    const CPL = profitLoss;

    // Get client user
    const clientUser = await tx.user.findUnique({
      where: { id: userId },
      include: { parent: true },
    });

    if (!clientUser) {
      throw new Error(`User ${userId} not found`);
    }

    // STEP 1 — CLIENT → AGENT
    // Agent owns 100% of client's P/L
    let AGENT_PL = CPL;
    let agentUser = clientUser.parent;

    // STEP 2 — AGENT → ADMIN
    let ADMIN_PL = 0;
    let ADMIN_FINAL = 0;
    let AGENT_FINAL = AGENT_PL;
    let adminUser: { id: string; commissionPercentage: number; parentId: string | null } | null = null;

    if (agentUser && agentUser.parentId) {
      // Get Agent's share (stored in commissionPercentage field)
      // This is AD% - Admin's share percentage
      const AD_SHARE = agentUser.commissionPercentage;
      ADMIN_PL = AGENT_PL * (AD_SHARE / 100);
      AGENT_FINAL = AGENT_PL - ADMIN_PL; // AGENT_PL * (1 - AD_SHARE / 100)

      // Get Admin (Agent's parent)
      const foundAdmin = await tx.user.findUnique({
        where: { id: agentUser.parentId },
      });
      if (foundAdmin) {
        adminUser = foundAdmin;
      }
    }

    // STEP 3 — ADMIN → SUPERADMIN
    let SUPER_PL = 0;
    let superAdminUser: { id: string } | null = null;

    if (adminUser) {
      // Get Admin's share (stored in commissionPercentage field)
      // This is SA% - SuperAdmin's share percentage
      const SA_SHARE = adminUser.commissionPercentage;
      SUPER_PL = ADMIN_PL * (SA_SHARE / 100);
      ADMIN_FINAL = ADMIN_PL - SUPER_PL; // ADMIN_PL * (1 - SA_SHARE / 100)

      // Get SuperAdmin (Admin's parent)
      if (adminUser.parentId) {
        const foundSuperAdmin = await tx.user.findUnique({
          where: { id: adminUser.parentId },
        });
        if (foundSuperAdmin) {
          superAdminUser = foundSuperAdmin;
        }
      }
    } else {
      ADMIN_FINAL = ADMIN_PL;
    }

    // FINAL BALANCE UPDATES
    // Update Agent balance
    if (agentUser) {
      const agentWallet = await tx.wallet.upsert({
        where: { userId: agentUser.id },
        update: {},
        create: { userId: agentUser.id, balance: 0, liability: 0 },
      });

      const liabilityToClear = Math.abs(AGENT_PL);

      await tx.wallet.update({
        where: { userId: agentUser.id },
        data: {
          liability: { decrement: liabilityToClear },
          balance: { increment: AGENT_FINAL },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: agentWallet.id,
          amount: Math.abs(AGENT_FINAL),
          type:
            AGENT_FINAL >= 0
              ? TransactionType.BET_WON
              : TransactionType.BET_LOST,
          description: `Settlement share for bet ${betId} on match ${matchId} - Agent final: ${AGENT_FINAL}`,
        },
      });
    }

    // Update Admin balance
    if (adminUser) {
      const adminWallet = await tx.wallet.upsert({
        where: { userId: adminUser.id },
        update: {},
        create: { userId: adminUser.id, balance: 0, liability: 0 },
      });

      await tx.wallet.update({
        where: { userId: adminUser.id },
        data: {
          balance: { increment: ADMIN_FINAL },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: adminWallet.id,
          amount: Math.abs(ADMIN_FINAL),
          type:
            ADMIN_FINAL >= 0
              ? TransactionType.BET_WON
              : TransactionType.BET_LOST,
          description: `Settlement share for bet ${betId} on match ${matchId} - Admin final: ${ADMIN_FINAL}`,
        },
      });
    }

    // Update SuperAdmin balance
    if (superAdminUser) {
      const superAdminWallet = await tx.wallet.upsert({
        where: { userId: superAdminUser.id },
        update: {},
        create: { userId: superAdminUser.id, balance: 0, liability: 0 },
      });

      await tx.wallet.update({
        where: { userId: superAdminUser.id },
        data: {
          balance: { increment: SUPER_PL },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: superAdminWallet.id,
          amount: Math.abs(SUPER_PL),
          type:
            SUPER_PL >= 0
              ? TransactionType.BET_WON
              : TransactionType.BET_LOST,
          description: `Settlement share for bet ${betId} on match ${matchId} - SuperAdmin share: ${SUPER_PL}`,
        },
      });
    }

    // Update Client wallet
    // CPL (Client Profit/Loss):
    // - Positive CPL = client loses money (already deducted, just clear liability)
    // - Negative CPL = client wins money (add to balance, clear liability)
    const clientWallet = await tx.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId, balance: 0, liability: 0 },
    });

    const liabilityToClear = Math.abs(CPL);
    const walletUpdateData: Prisma.WalletUpdateInput = {
      liability: { decrement: liabilityToClear },
    };

    // If client won (negative CPL means profit), add to balance
    if (CPL < 0) {
      walletUpdateData.balance = { increment: Math.abs(CPL) };
    }

    await tx.wallet.update({
      where: { userId },
      data: walletUpdateData,
    });

    await tx.transaction.create({
      data: {
        walletId: clientWallet.id,
        amount: Math.abs(CPL),
        type:
          CPL < 0 // Negative CPL means client won
            ? TransactionType.BET_WON
            : TransactionType.BET_LOST,
        description: `Settlement for bet ${betId} on match ${matchId} (${outcome})`,
      },
    });
  }

  /**
   * Get list of settlement_ids that need settlement (with pending bets)
   * Includes match info and bet counts
   */
  async getSettlementIdsNeedingSettlement() {
    // Filter by gtype: fancy, fancy1, Normal, oddeven (like PHP code)
    // Note: PHP code doesn't require settlementId, so we make it optional
    // Also include "fancy" (not just "fancy1") based on actual data
    // Also include bets where marketName is "Normal" (session bets)
    const bets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        OR: [
          {
            gtype: {
              in: ['fancy', 'fancy1', 'Normal', 'oddeven'],
            },
          },
          {
            marketName: 'Normal', // Session bets often have marketName "Normal"
          },
        ],
        // Remove match status filter to show all pending bets (like PHP)
        // match: {
        //   status: {
        //     in: [MatchStatus.FINISHED, MatchStatus.LIVE],
        //   },
        // },
      },
      include: {
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventId: true,
            eventName: true,
            startTime: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group by match_id, selection_id, gtype, bet_name (like PHP code)
    const groupedMap = new Map<
      string,
      {
        match_id: string;
        selection_id: number | null;
        gtype: string | null;
        bet_name: string | null;
        match: any;
        pending_bets_count: number;
        total_bet_amount: number;
        created_at: Date;
        settlement_ids: Set<string>;
      }
    >();

    for (const bet of bets) {
      // Create unique key: match_id + selection_id + gtype + bet_name
      // Note: settlementId is optional, so we don't skip bets without it
      const groupKey = `${bet.matchId}_${bet.selectionId ?? 'null'}_${bet.gtype ?? 'null'}_${bet.betName ?? 'null'}`;

      const existing = groupedMap.get(groupKey);
      if (existing) {
        existing.pending_bets_count += 1;
        existing.total_bet_amount += Number(bet.amount || 0);
        if (bet.settlementId) {
          existing.settlement_ids.add(bet.settlementId);
        }
        // Keep earliest created_at
        if (bet.createdAt < existing.created_at) {
          existing.created_at = bet.createdAt;
        }
      } else {
        groupedMap.set(groupKey, {
          match_id: bet.matchId,
          selection_id: bet.selectionId,
          gtype: bet.gtype,
          bet_name: bet.betName,
          match: bet.match,
          pending_bets_count: 1,
          total_bet_amount: Number(bet.amount || 0),
          created_at: bet.createdAt,
          settlement_ids: bet.settlementId ? new Set([bet.settlementId]) : new Set(),
        });
      }
    }

    // Convert to array format similar to PHP
    return Array.from(groupedMap.values()).map((group) => ({
      match_id: group.match_id,
      selection_id: group.selection_id,
      gtype: group.gtype,
      bet_name: group.bet_name,
      match: group.match,
      pending_bets_count: group.pending_bets_count,
      total_bet_amount: group.total_bet_amount,
      created_at: group.created_at,
      settlement_ids: Array.from(group.settlement_ids),
    }));
  }

  /**
   * Get details for a specific settlement_id
   * Returns match info, all bets, and their status
   */
  async getSettlementDetails(settlementId: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
      },
      include: {
        match: true,
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (bets.length === 0) {
      return null;
    }

    const matchId = bets[0].matchId;
    const match = bets[0].match;

    // Count bets by status
    const statusCounts = {
      PENDING: bets.filter((b) => b.status === BetStatus.PENDING).length,
      WON: bets.filter((b) => b.status === BetStatus.WON).length,
      LOST: bets.filter((b) => b.status === BetStatus.LOST).length,
      CANCELLED: bets.filter((b) => b.status === BetStatus.CANCELLED).length,
    };

    // Calculate totals
    const totalPendingAmount = bets
      .filter((b) => b.status === BetStatus.PENDING)
      .reduce((sum, b) => sum + Number(b.amount || 0), 0);

    const firstBet = bets[0];

    return {
      settlement_id: settlementId,
      match_id: matchId,
      match: {
        id: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        eventId: match.eventId,
        eventName: match.eventName,
        startTime: match.startTime,
        status: match.status,
      },
      bet_info: {
        betName: firstBet.betName,
        marketName: firstBet.marketName,
        gtype: firstBet.gtype,
        selectionId: firstBet.selectionId,
      },
      status_counts: statusCounts,
      total_pending_amount: totalPendingAmount,
      total_bets: bets.length,
      bets: bets.map((bet) => ({
        id: bet.id,
        userId: bet.userId,
        user: bet.user,
        amount: bet.amount,
        odds: bet.odds,
        betName: bet.betName,
        selectionId: bet.selectionId,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        status: bet.status,
        createdAt: bet.createdAt,
        updatedAt: bet.updatedAt,
      })),
    };
  }

  /**
   * Get bets with settlement status
   * Can filter by status, match_id, or settlement_id
   */
  async getBetsWithStatus(filters?: {
    status?: BetStatus;
    matchId?: string;
    settlementId?: string;
    userId?: string;
    limit?: number;
  }) {
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.matchId) {
      where.matchId = filters.matchId;
    }

    if (filters?.settlementId) {
      where.settlementId = filters.settlementId;
    }

    if (filters?.userId) {
      where.userId = filters.userId;
    }

    const bets = await this.prisma.bet.findMany({
      where,
      include: {
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            status: true,
            startTime: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: filters?.limit || 100,
    });

    return bets.map((bet) => ({
      id: bet.id,
      settlement_id: bet.settlementId,
      match_id: bet.matchId,
      selection_id: bet.selectionId,
      user: bet.user,
      match: bet.match,
      amount: bet.amount,
      odds: bet.odds,
      betName: bet.betName,
      marketName: bet.marketName,
      gtype: bet.gtype,
      winAmount: bet.winAmount,
      lossAmount: bet.lossAmount,
      status: bet.status,
      createdAt: bet.createdAt,
      updatedAt: bet.updatedAt,
    }));
  }

  /**
   * Get all settlement results (all settled bets)
   * Returns all bets that have been settled (WON or LOST status)
   */
  async getAllSettlementResults(filters?: {
    matchId?: string;
    settlementId?: string;
    userId?: string;
    status?: BetStatus;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {
      status: {
        in: [BetStatus.WON, BetStatus.LOST],
      },
    };

    if (filters?.matchId) {
      where.matchId = filters.matchId;
    }

    if (filters?.settlementId) {
      where.settlementId = filters.settlementId;
    }

    if (filters?.userId) {
      where.userId = filters.userId;
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    const [bets, total] = await Promise.all([
      this.prisma.bet.findMany({
        where,
        include: {
          match: {
            select: {
              id: true,
              homeTeam: true,
              awayTeam: true,
              eventName: true,
              status: true,
              startTime: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: filters?.limit || 100,
        skip: filters?.offset || 0,
      }),
      this.prisma.bet.count({ where }),
    ]);

    return {
      total,
      results: bets.map((bet) => ({
        id: bet.id,
        settlement_id: bet.settlementId,
        match_id: bet.matchId,
        selection_id: bet.selectionId,
        user: bet.user,
        match: bet.match,
        amount: bet.amount,
        odds: bet.odds,
        betName: bet.betName,
        marketName: bet.marketName,
        gtype: bet.gtype,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        status: bet.status,
        profitLoss:
          bet.status === BetStatus.WON
            ? Number(bet.winAmount || bet.amount * bet.odds)
            : -Number(bet.lossAmount || bet.amount),
        createdAt: bet.createdAt,
        updatedAt: bet.updatedAt,
      })),
    };
  }

  /**
   * Reverse a settlement
   * This will:
   * 1. Revert bet status back to PENDING
   * 2. Reverse wallet transactions (undo profit/loss)
   * 3. Restore liability
   */
  async reverseSettlement(settlementId: string): Promise<{
    success: boolean;
    message: string;
    reversed?: Array<{
      betId: string;
      userId: string;
      previousStatus: BetStatus;
      reversedAmount: number;
    }>;
  }> {
    if (!settlementId) {
      return { success: false, message: 'settlement_id is required' };
    }

    // Get all settled bets for this settlement_id
    const settledBets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: {
          in: [BetStatus.WON, BetStatus.LOST],
        },
      },
      include: {
        user: {
          include: {
            wallet: true,
          },
        },
        match: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (settledBets.length === 0) {
      return {
        success: false,
        message: `No settled bets found for settlement_id: ${settlementId}`,
      };
    }

    const matchId = settledBets[0].matchId;

    const reversed = await this.prisma.$transaction(async (tx) => {
      const summary: Array<{
        betId: string;
        userId: string;
        previousStatus: BetStatus;
        reversedAmount: number;
      }> = [];

      for (const bet of settledBets) {
        const previousStatus = bet.status;
        const wasWon = previousStatus === BetStatus.WON;
        const profitLoss = wasWon
          ? Number(bet.winAmount || bet.amount * bet.odds)
          : -Number(bet.lossAmount || bet.amount);

        // Revert bet status to PENDING
        await tx.bet.update({
          where: { id: bet.id },
          data: {
            status: BetStatus.PENDING,
            updatedAt: new Date(),
          },
        });

        // Reverse wallet mutation
        if (bet.user.wallet) {
          const liabilityToRestore = Math.abs(profitLoss);

          await tx.wallet.update({
            where: { id: bet.user.wallet.id },
            data: {
              liability: { increment: liabilityToRestore }, // restore liability
              balance: { decrement: profitLoss }, // reverse profit/loss
            },
          });

          // Create a reversal transaction
          await tx.transaction.create({
            data: {
              walletId: bet.user.wallet.id,
              amount: Math.abs(profitLoss),
              type: TransactionType.REFUND,
              description: `Settlement reversal for bet ${bet.id} on match ${matchId} (previously ${previousStatus})`,
            },
          });
        }

        summary.push({
          betId: bet.id,
          userId: bet.userId,
          previousStatus,
          reversedAmount: profitLoss,
        });
      }

      // Update match status if needed (if there are now pending bets)
      const pendingBetsCount = await tx.bet.count({
        where: {
          matchId,
          status: BetStatus.PENDING,
        },
      });

      if (pendingBetsCount > 0) {
        await tx.match.updateMany({
          where: { id: matchId },
          data: {
            status: MatchStatus.LIVE, // or FINISHED, depending on your logic
            updatedAt: new Date(),
          },
        });
      }

      return summary;
    });

    return {
      success: true,
      message: `Successfully reversed settlement for ${reversed.length} bet(s)`,
      reversed,
    };
  }

  /**
   * Get pending settlements for a specific match
   * Returns all settlement_ids with pending bets for the given match
   */
  async getPendingSettlementsByMatch(matchId: string) {
    if (!matchId) {
      return {
        success: false,
        message: 'match_id is required',
      };
    }

    // Verify match exists
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        homeTeam: true,
        awayTeam: true,
        eventId: true,
        eventName: true,
        startTime: true,
        status: true,
      },
    });

    if (!match) {
      return {
        success: false,
        message: `Match not found: ${matchId}`,
      };
    }

    // Get all pending bets for this match
    const bets = await this.prisma.bet.findMany({
      where: {
        matchId,
        status: BetStatus.PENDING,
        settlementId: { not: null },
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
      orderBy: { createdAt: 'desc' },
    });

    // Group by settlement_id
    const settlementMap = new Map<
      string,
      {
        settlement_id: string;
        pending_bets_count: number;
        total_bet_amount: number;
        bets: any[];
      }
    >();

    for (const bet of bets) {
      if (!bet.settlementId) continue;

      const existing = settlementMap.get(bet.settlementId);
      if (existing) {
        existing.pending_bets_count += 1;
        existing.total_bet_amount += Number(bet.amount || 0);
        existing.bets.push({
          id: bet.id,
          userId: bet.userId,
          user: bet.user,
          amount: bet.amount,
          odds: bet.odds,
          betName: bet.betName,
          selectionId: bet.selectionId,
          marketName: bet.marketName,
          winAmount: bet.winAmount,
          lossAmount: bet.lossAmount,
          createdAt: bet.createdAt,
        });
      } else {
        settlementMap.set(bet.settlementId, {
          settlement_id: bet.settlementId,
          pending_bets_count: 1,
          total_bet_amount: Number(bet.amount || 0),
          bets: [
            {
              id: bet.id,
              userId: bet.userId,
              user: bet.user,
              amount: bet.amount,
              odds: bet.odds,
              betName: bet.betName,
              selectionId: bet.selectionId,
              marketName: bet.marketName,
              winAmount: bet.winAmount,
              lossAmount: bet.lossAmount,
              createdAt: bet.createdAt,
            },
          ],
        });
      }
    }

    return {
      success: true,
      match,
      settlement_count: settlementMap.size,
      settlements: Array.from(settlementMap.values()),
    };
  }
}
