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
   * @param bets - Array of bets for this Match Odds market
   * @returns Net exposure (worst-case loss) for this market
   */
  calculateMatchOddsExposureInMemory(bets: any[]): number {
    if (!bets.length) return 0;

    const positionBySelection = this.buildMatchOddsPositions(bets);

    let maxLoss = 0;
    const selections = Array.from(positionBySelection.keys());

    /**
     * SCENARIO A:
     * Each selection wins one by one
     */
    for (const winner of selections) {
      let pnl = 0;

      for (const [sid, pos] of positionBySelection) {
        pnl += sid === winner ? pos.win : pos.lose;
      }

      if (pnl < 0) {
        maxLoss = Math.max(maxLoss, Math.abs(pnl));
      }
    }

    /**
     * SCENARIO B:
     * Some OTHER runner wins (not bet by user)
     * → all selections lose
     */
    let allLosePnl = 0;
    for (const pos of positionBySelection.values()) {
      allLosePnl += pos.lose;
    }

    if (allLosePnl < 0) {
      maxLoss = Math.max(maxLoss, Math.abs(allLosePnl));
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

