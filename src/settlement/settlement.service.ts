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

  async settleMatch(matchId: string): Promise<SettlementResult> {
    if (!matchId) {
      return { success: false, message: 'match_id is required' };
    }

    const pendingBets = await this.getPendingBets(matchId);
    if (pendingBets.length === 0) {
      return {
        success: true,
        match_id: matchId,
        message: 'No pending bets to settle.',
      };
    }

    const matchResult = await this.fetchMatchResult(matchId, pendingBets[0]);
    if (!matchResult) {
      return {
        success: false,
        match_id: matchId,
        message: 'Unable to fetch result from provider.',
      };
    }

    if (!matchResult.winner) {
      return {
        success: false,
        match_id: matchId,
        message: 'Result not ready yet.',
      };
    }

    this.logger.log(
      `Settling ${pendingBets.length} bets on match ${matchId} with winner ${matchResult.winner}`,
    );

    const settled = await this.prisma.$transaction(async (tx) => {
      const summary: SettlementResult['settled'] = [];

      for (const bet of pendingBets) {
        const outcome = this.determineOutcome(bet, matchResult.winner);
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

      await tx.match.updateMany({
        where: { id: matchId },
        data: {
          status: MatchStatus.FINISHED,
          updatedAt: new Date(),
        },
      });

      return summary ?? [];
    });

    return {
      success: true,
      match_id: matchId,
      settled,
    };
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async autoSettlementCron() {
    const matchIds = await this.getMatchesAwaitingSettlement();
    if (matchIds.length === 0) {
      return;
    }

    this.logger.log(
      `Auto settlement triggered for matches: ${matchIds.join(', ')}`,
    );

    for (const matchId of matchIds) {
      try {
        await this.settleMatch(matchId);
      } catch (error) {
        this.logger.error(
          `Failed to auto-settle match ${matchId}`,
          (error as Error).stack,
        );
      }
    }
  }

  private async getPendingBets(matchId: string) {
    return this.prisma.bet.findMany({
      where: {
        matchId,
        status: BetStatus.PENDING,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async getMatchesAwaitingSettlement(): Promise<string[]> {
    const matches = await this.prisma.bet.findMany({
      where: { status: BetStatus.PENDING },
      select: { matchId: true },
      distinct: ['matchId'],
      take: 25,
    });

    return matches.map((item) => item.matchId);
  }

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

    const payload = {
      event_id: Number(matchDetails?.eventId ?? matchId),
      event_name:
        matchDetails?.eventName ??
        (matchDetails?.homeTeam && matchDetails?.awayTeam
          ? `${matchDetails.homeTeam} vs ${matchDetails.awayTeam}`
          : referenceBet?.marketName ??
            referenceBet?.betName ??
            'Unknown Event'),
      market_id: Number(
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
    };
  
    const params = new URLSearchParams({
      key: this.apiKey,
      sid: this.apiSid,
    });
  
    const url = `${this.baseUrl}/get-result?${params.toString()}`;
  
    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
      });
  
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(
          `Failed to fetch result for match ${matchId} - Status: ${error.response?.status} - Data: ${JSON.stringify(error.response?.data)}`,
        );
      } else {
        this.logger.error(
          `Failed to fetch result for match ${matchId} - Unknown error: ${(error as Error).stack}`,
        );
      }
      return null;
    }
  }
  

  private determineOutcome(bet: any, winner: string) {
    const betSelection =
      bet.bet_name ??
      bet.selection ??
      bet.selectionName ??
      bet.market_name ??
      null;

    if (!betSelection) {
      return null;
    }

    const winAmount =
      Number(bet.win_amount ?? bet.winAmount ?? bet.amount * bet.odds) || 0;
    const lossAmount =
      Number(bet.loss_amount ?? bet.lossAmount ?? bet.amount) || 0;

    if (betSelection === winner) {
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
    const wallet = await tx.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: {
          increment: profitLoss,
        },
      },
    });

    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        amount: Math.abs(profitLoss),
        type:
          profitLoss >= 0
            ? TransactionType.BET_WON
            : TransactionType.BET_LOST,
        description: `Settlement for bet ${betId} on match ${matchId} (${outcome})`,
      },
    });
  }
}
