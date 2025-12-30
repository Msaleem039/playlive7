import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface BetInput {
  userId: string;
  matchId: string;
  marketType: string;
  selectionId: number;
  betType: 'BACK' | 'LAY';
  stake: number;
  odds: number;
  runnerName?: string;
}

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Update position from a bet placement
   * This handles BACK/LAY netting automatically
   * 
   * Example:
   * - BACK 1000 @ 2.0 → backStake: 1000, pnlIfWin: +1000, pnlIfLose: -1000
   * - LAY 1000 @ 2.0 → layStake: 1000, pnlIfWin: -1000, pnlIfLose: +1000
   * - Combined: pnlIfWin: 0, pnlIfLose: 0 (perfect hedge)
   * 
   * @param bet - Bet input data
   * @param tx - Optional transaction client for atomic operations
   */
  async updatePositionFromBet(bet: BetInput, tx?: any) {
    try {
      const client = tx || this.prisma;
      return await client.position.upsert({
        where: {
          userId_matchId_marketType_selectionId: {
            userId: bet.userId,
            matchId: bet.matchId,
            marketType: bet.marketType,
            selectionId: bet.selectionId,
          },
        },
        create: this.createPosition(bet),
        update: this.mergePosition(bet),
      });
    } catch (error) {
      this.logger.error(
        `Error updating position for bet: ${JSON.stringify(bet)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Create a new position from a bet
   */
  private createPosition(bet: BetInput) {
    const base = this.base(bet);

    if (bet.betType === 'BACK') {
      return {
        ...base,
        backStake: bet.stake,
        backOdds: bet.odds,
        pnlIfWin: bet.stake * (bet.odds - 1), // Profit if selection wins
        pnlIfLose: -bet.stake, // Loss if selection loses (stake is lost)
      };
    } else {
      // LAY bet
      return {
        ...base,
        layStake: bet.stake,
        layOdds: bet.odds,
        pnlIfWin: -bet.stake * (bet.odds - 1), // Loss if selection wins (pay out)
        pnlIfLose: bet.stake, // Profit if selection loses (keep stake)
      };
    }
  }

  /**
   * Merge a new bet into an existing position
   * This handles BACK + LAY netting automatically
   */
  private mergePosition(bet: BetInput) {
    const updateData: any = {};

    if (bet.betType === 'BACK') {
      // Increment back stake and odds (weighted average could be added later)
      updateData.backStake = { increment: bet.stake };
      // For simplicity, we'll use the latest odds (could be weighted average)
      updateData.backOdds = bet.odds;
      
      // Increment P/L calculations
      updateData.pnlIfWin = { increment: bet.stake * (bet.odds - 1) };
      updateData.pnlIfLose = { increment: -bet.stake };
    } else {
      // LAY bet
      updateData.layStake = { increment: bet.stake };
      updateData.layOdds = bet.odds;
      
      // Increment P/L calculations (negative for win, positive for lose)
      updateData.pnlIfWin = { increment: -bet.stake * (bet.odds - 1) };
      updateData.pnlIfLose = { increment: bet.stake };
    }

    // Update runner name if provided
    if (bet.runnerName) {
      updateData.runnerName = bet.runnerName;
    }

    return updateData;
  }

  /**
   * Base fields for position
   */
  private base(bet: BetInput) {
    return {
      userId: bet.userId,
      matchId: bet.matchId,
      marketType: bet.marketType,
      selectionId: bet.selectionId,
      runnerName: bet.runnerName,
    };
  }

  /**
   * Get positions for a user in a match
   * Useful for displaying P/L in UI
   */
  async getPositionsByMatch(userId: string, matchId: string, marketType?: string) {
    const where: any = {
      userId,
      matchId,
    };

    if (marketType) {
      where.marketType = marketType;
    }

    return this.prisma.position.findMany({
      where,
      orderBy: {
        selectionId: 'asc',
      },
    });
  }

  /**
   * Get all positions for a user
   */
  async getPositionsByUser(userId: string) {
    return this.prisma.position.findMany({
      where: { userId },
      orderBy: [
        { matchId: 'asc' },
        { marketType: 'asc' },
        { selectionId: 'asc' },
      ],
    });
  }

  /**
   * Get position for a specific selection
   */
  async getPosition(
    userId: string,
    matchId: string,
    marketType: string,
    selectionId: number,
  ) {
    return this.prisma.position.findUnique({
      where: {
        userId_matchId_marketType_selectionId: {
          userId,
          matchId,
          marketType,
          selectionId,
        },
      },
    });
  }
}

