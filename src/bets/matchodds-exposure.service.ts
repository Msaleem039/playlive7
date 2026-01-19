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
   * ✅ DRAW HANDLING:
   * - If marketSelections is provided and contains DRAW selectionId,
   *   and user has NOT bet on DRAW, inject DRAW with zero PnL
   * - This ensures DRAW outcome is simulated even if user hasn't bet on it
   * 
   * @param bets - Array of Match Odds bets
   * @param marketSelections - Optional array of all valid selectionIds for this market (including DRAW)
   * @returns Map of selectionId to { win: number, lose: number }
   */
  private buildMatchOddsPositions(
    bets: any[],
    marketSelections?: number[],
  ): Map<number, { win: number; lose: number }> {
    const map = new Map<number, { win: number; lose: number }>();

    // Build positions from user bets
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

    // ✅ DRAW INJECTION: Inject DRAW selection if it exists in market but user hasn't bet on it
    if (marketSelections && marketSelections.length > 0) {
      for (const selectionId of marketSelections) {
        // If selection exists in market but user hasn't bet on it, inject with zero PnL
        if (!map.has(selectionId)) {
          map.set(selectionId, { win: 0, lose: 0 });
        }
      }
    }

    return map;
  }

  /**
   * Calculate Match Odds exposure in memory (no database queries)
   * 
   * ✅ MARKET-CORRECT APPROACH:
   * - Simulates ALL REAL outcomes (each selection wins, including DRAW if applicable)
   * - Removes imaginary "all lose" scenarios
   * - Injects DRAW selection if it exists in market but user hasn't bet on it
   * 
   * @param bets - Array of bets for this Match Odds market
   * @param marketSelections - Optional array of all valid selectionIds for this market (including DRAW)
   * @returns Net exposure (worst-case loss) for this market
   */
  calculateMatchOddsExposureInMemory(
    bets: any[],
    marketSelections?: number[],
  ): number {
    if (!bets.length) return 0;

    // Build position map (with DRAW injection if applicable)
    const positionBySelection = this.buildMatchOddsPositions(bets, marketSelections);

    let maxLoss = 0;
    const selections = Array.from(positionBySelection.keys());

    /**
     * ✅ SIMULATE ALL REAL OUTCOMES:
     * Each selection wins one by one (including DRAW if injected)
     * 
     * This covers:
     * - Home team wins
     * - Away team wins
     * - DRAW (if applicable and injected)
     * 
     * ❌ REMOVED: Imaginary "all lose" scenario
     * This was incorrect because in Match Odds, one of the real selections MUST win
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
   * - Handles DRAW outcomes if marketSelections is provided
   * 
   * @param existingBets - Existing pending bets for this marketId (without new bet)
   * @param newBet - The new bet being placed
   * @param marketSelections - Optional array of all valid selectionIds for this market (including DRAW)
   * @returns Exposure delta (positive = liability increases, negative = liability releases)
   */
  calculateMatchOddsExposureDelta(
    existingBets: any[],
    newBet: any,
    marketSelections?: number[],
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
    const oldExposure = this.calculateMatchOddsExposureInMemory(
      matchOddsExistingBets,
      marketSelections,
    );

    // Add new bet and calculate new exposure
    const matchOddsNewBets = [...matchOddsExistingBets, newBet];
    const newExposure = this.calculateMatchOddsExposureInMemory(
      matchOddsNewBets,
      marketSelections,
    );

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

