import { Injectable, Logger } from '@nestjs/common';

/**
 * ✅ MATCH ODDS EXPOSURE SERVICE
 * 
 * Handles all exposure calculations for Match Odds markets.
 * Supports BACK ↔ LAY offset in both directions.
 */
@Injectable()
export class MatchOddsExposureService {
  private readonly logger = new Logger(MatchOddsExposureService.name);

  /**
   * Build position map per selection for Match Odds bets
   * 
   * @param bets - Array of Match Odds bets
   * @returns Map of selectionId to { win: number, lose: number }
   */
  private buildMatchOddsPositions(bets: any[]): Map<number, { win: number; lose: number }> {
    const map = new Map<number, { win: number; lose: number }>();

    for (const bet of bets) {
      const selectionId = Number(bet.selectionId ?? bet.selection_id);
      if (!selectionId) continue;

      const stake = Number(bet.betValue ?? bet.betvalue ?? bet.amount ?? 0);
      const odds = Number(bet.betRate ?? bet.bet_rate ?? bet.odds ?? 0);
      const type = String(bet.betType ?? bet.bet_type ?? '').toUpperCase();

      if (!map.has(selectionId)) {
        map.set(selectionId, { win: 0, lose: 0 });
      }

      const pos = map.get(selectionId)!;
      const profit = (odds - 1) * stake;

      if (type === 'BACK') {
        pos.win += profit; // if wins
        pos.lose -= stake; // if loses
      }

      if (type === 'LAY') {
        pos.win -= profit; // if wins (liability)
        pos.lose += stake; // if loses (stake kept)
      }
    }

    return map;
  }

  /**
   * Calculate Match Odds exposure in memory (no database queries)
   * 
   * Uses worst-case PnL simulation across all possible outcomes.
   * 
   * ✅ MATCH ODDS RULE: One selection MUST win - there is no "all lose" scenario.
   * We simulate each selection winning and find the worst-case loss.
   * 
   * 🔐 CRITICAL FIX: We must simulate ALL possible outcomes to capture BACK bet exposure.
   * For each selection we have bets on:
   * 1. Simulate that selection winning
   * 2. Simulate that selection losing (when another selection wins)
   * 
   * This ensures BACK bets correctly generate exposure even when they're the only bets.
   * 
   * @param bets - Array of bets for this Match Odds market
   * @returns Net exposure (worst-case loss) for this market
   */
  calculateMatchOddsExposureInMemory(bets: any[]): number {
    if (!bets.length) return 0;

    const positionBySelection = this.buildMatchOddsPositions(bets);

    let maxLoss = 0;
    const selections = Array.from(positionBySelection.keys());

    /**
     * ✅ SIMULATE ALL REAL OUTCOMES:
     * For each selection we have bets on, simulate:
     * 1. This selection winning (all others lose)
     * 2. This selection losing (one other selection wins - worst case)
     * 
     * This ensures we capture worst-case loss for BACK bets.
     */
    
    // Scenario A: Simulate each selection winning
    for (const winner of selections) {
      let pnl = 0;

      for (const [sid, pos] of positionBySelection) {
        pnl += sid === winner ? pos.win : pos.lose;
      }

      if (pnl < 0) {
        maxLoss = Math.max(maxLoss, Math.abs(pnl));
      }
    }

    // Scenario B: Simulate each selection losing (critical for BACK bets)
    // When a selection loses, another selection must win
    // This captures the loss scenario for BACK bets even when they're isolated
    for (const loser of selections) {
      // If this is the only selection with bets, simulate it losing
      // (Another selection wins, but we don't have bets on it)
      if (selections.length === 1) {
        const pos = positionBySelection.get(loser)!;
        const pnl = pos.lose; // This selection loses

        if (pnl < 0) {
          maxLoss = Math.max(maxLoss, Math.abs(pnl));
        }
      } else {
        // Multiple selections with bets: simulate each other selection winning
        // when this selection loses
        for (const winner of selections) {
          if (winner === loser) continue; // Skip if same selection

          let pnl = 0;
          for (const [sid, pos] of positionBySelection) {
            if (sid === loser) {
              // This selection loses
              pnl += pos.lose;
            } else if (sid === winner) {
              // This other selection wins
              pnl += pos.win;
            } else {
              // Other selections lose (since winner won)
              pnl += pos.lose;
            }
          }

          if (pnl < 0) {
            maxLoss = Math.max(maxLoss, Math.abs(pnl));
          }
        }
      }
    }

    return maxLoss;
  }

  /**
   * ✅ MATCH ODDS EXPOSURE DELTA CALCULATOR
   * 
   * Calculates exposure delta for Match Odds bets ONLY.
   * This ensures BACK → LAY and LAY → BACK offsets work correctly.
   * 
   * Rules:
   * - Only considers bets with same marketId
   * - Calculates old exposure (without new bet)
   * - Calculates new exposure (with new bet)
   * - Returns delta = newExposure - oldExposure (can be negative)
   * - Supports FULL OFFSET: BACK → LAY reverses, LAY → BACK reverses
   * 
   * @param existingBets - Existing pending bets for this marketId (without new bet)
   * @param newBet - The new bet being placed
   * @returns Exposure delta (positive = liability increases, negative = liability releases)
   */
  calculateMatchOddsExposureDelta(
    existingBets: any[],
    newBet: any,
  ): number {
    // Filter to only Match Odds bets for this marketId
    const marketId = newBet.marketId;
    const matchOddsExistingBets = existingBets.filter((bet) => {
      const betGtype = (bet.gtype || '').toLowerCase();
      return (
        (betGtype === 'matchodds' || betGtype === 'match') &&
        bet.marketId === marketId
      );
    });

    // Calculate old exposure (without new bet)
    const oldExposure = this.calculateMatchOddsExposureInMemory(matchOddsExistingBets);

    // Add new bet and calculate new exposure
    const matchOddsNewBets = [...matchOddsExistingBets, newBet];
    const newExposure = this.calculateMatchOddsExposureInMemory(matchOddsNewBets);

    // Return delta (can be negative for offsets)
    // Positive delta = liability increases (lock funds)
    // Negative delta = liability releases (return funds)
    const delta = newExposure - oldExposure;

    this.logger.debug(
      `Match Odds exposure delta: oldExposure=${oldExposure}, newExposure=${newExposure}, delta=${delta}`,
    );

    return delta;
  }
}

