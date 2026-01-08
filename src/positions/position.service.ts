import { Injectable } from '@nestjs/common';
import { Bet } from '@prisma/client';

/**
 * Position Service
 * 
 * Calculates positions (P/L projections) for each selection based on BACK/LAY bets.
 * This service is isolated and does not interfere with other betting logic.
 */

export interface BetInput {
  selectionId: string | number;
  betType: 'BACK' | 'LAY';
  odds: number;
  stake: number;
}

/**
 * Calculate positions for each selection based on bets
 * 
 * Position calculation rules:
 * - BACK bet on winning selection: + (odds - 1) * stake
 * - BACK bet on losing selection: - stake
 * - LAY bet on winning selection: - (odds - 1) * stake
 * - LAY bet on losing selection: + stake
 * 
 * @param selections - Array of selection IDs (as strings)
 * @param bets - Array of bets to calculate positions from
 * @returns Record mapping selection ID to position value
 */
export function calculatePositions(
  selections: string[],
  bets: Bet[],
): Record<string, number> {
  const position: Record<string, number> = {};

  // Initialize all selections to 0
  for (const s of selections) {
    position[s] = 0;
  }

  // Calculate position for each bet
  for (const bet of bets) {
    // Skip bets without selectionId
    if (bet.selectionId === null && bet.selectionId !== 0) {
      continue;
    }

    const betSelectionId = String(bet.selectionId);
    const betType = bet.betType?.toUpperCase();
    const odds = bet.betRate ?? bet.odds ?? 0;
    const stake = bet.betValue ?? bet.amount ?? 0;

    // Skip invalid bets
    if (!betType || (betType !== 'BACK' && betType !== 'LAY') || odds <= 0 || stake <= 0) {
      continue;
    }

    // Calculate position impact for each selection
    for (const selection of selections) {
      const isWinOutcome = selection === betSelectionId;

      if (betType === 'BACK') {
        position[selection] += isWinOutcome
          ? (odds - 1) * stake  // Win: profit = (odds - 1) * stake
          : -stake;              // Lose: loss = stake
      }

      if (betType === 'LAY') {
        position[selection] += isWinOutcome
          ? -(odds - 1) * stake  // Win: loss = (odds - 1) * stake
          : stake;                // Lose: profit = stake
      }
    }
  }

  return position;
}

@Injectable()
export class PositionService {
  /**
   * Calculate positions for selections based on bets
   * 
   * @param selections - Array of selection IDs (as strings)
   * @param bets - Array of Bet objects from database
   * @returns Record mapping selection ID to position value
   */
  calculatePositions(selections: string[], bets: Bet[]): Record<string, number> {
    return calculatePositions(selections, bets);
  }

  /**
   * Calculate positions with typed bet input (for testing or external use)
   * 
   * @param selections - Array of selection IDs (as strings)
   * @param bets - Array of BetInput objects
   * @returns Record mapping selection ID to position value
   */
  calculatePositionsFromInput(
    selections: string[],
    bets: BetInput[],
  ): Record<string, number> {
    const position: Record<string, number> = {};

    // Initialize all selections to 0
    for (const s of selections) {
      position[s] = 0;
    }

    // Calculate position for each bet
    for (const bet of bets) {
      const betSelectionId = String(bet.selectionId);

      // Calculate position impact for each selection
      for (const selection of selections) {
        const isWinOutcome = selection === betSelectionId;

        if (bet.betType === 'BACK') {
          position[selection] += isWinOutcome
            ? (bet.odds - 1) * bet.stake
            : -bet.stake;
        }

        if (bet.betType === 'LAY') {
          position[selection] += isWinOutcome
            ? -(bet.odds - 1) * bet.stake
            : bet.stake;
        }
      }
    }

    return position;
  }
}






