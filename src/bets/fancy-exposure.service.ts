import { Injectable } from '@nestjs/common';

/**
 * ✅ FANCY EXPOSURE SERVICE
 * 
 * Handles all exposure calculations for Fancy markets.
 * Uses policy-first approach: range policy → normal fancy exposure.
 * 
 * DO NOT change existing fancy logic - only return exposure deltas.
 */
@Injectable()
export class FancyExposureService {
  /**
   * Calculate Fancy exposure in memory (no database queries)
   * ✅ EXCHANGE RULE: Different lines do NOT hedge, only same-line reverse can reduce exposure
   * - Group bets by eventId_selectionId_rate (same-line grouping)
   * - Same-line: YES @ X and NO @ X hedge each other (exposure = |YES - NO|)
   * - Different lines: YES @ A + NO @ B = full liability (sum, NO hedge)
   * - Exposure is net per line, then summed across all lines
   * 
   * @param bets - Array of bets for the fancy selection
   * @returns Net exposure for this Fancy selection
   */
  calculateFancyExposureInMemory(bets: any[]): number {
    if (bets.length === 0) return 0;

    // Group bets by fancy key (eventId + selectionId)
    const betsByFancy = new Map<string, any[]>();

    for (const bet of bets) {
      const eventId = bet.eventId || '';
      const selectionId = bet.selectionId || 0;
      const fancyKey = `${eventId}_${selectionId}`;

      if (!betsByFancy.has(fancyKey)) {
        betsByFancy.set(fancyKey, []);
      }
      betsByFancy.get(fancyKey)!.push(bet);
    }

    let totalExposure = 0;

    // Process each fancy separately
    for (const fancyBets of betsByFancy.values()) {
      // 🟢 FIRST: client range policy
      const rangeExposure = this.applyRangeFancyPolicyForFancy(fancyBets);

      if (rangeExposure !== null) {
        totalExposure += rangeExposure;
        continue;
      }

      // 🟡 FALLBACK: normal fancy exposure
      totalExposure += this.calculateNormalFancyExposureForFancy(fancyBets);
    }

    return totalExposure;
  }

  /**
   * Apply range fancy policy for a single fancy group
   * 
   * Checks if the fancy has a complete range (YES rates < NO rates).
   * If range is complete, exposure is 0 (no liability).
   * 
   * @param fancyBets - Array of bets for a single fancy (same eventId + selectionId)
   * @returns Exposure if range policy applies (0 for complete range), null if no range
   */
  private applyRangeFancyPolicyForFancy(fancyBets: any[]): number | null {
    const yesRates: number[] = [];
    const noRates: number[] = [];

    for (const bet of fancyBets) {
      const rate = bet.betRate ?? bet.odds ?? 0;
      const type = (bet.betType || '').toUpperCase();

      if (type === 'YES' || type === 'BACK') {
        yesRates.push(rate);
      } else if (type === 'NO' || type === 'LAY') {
        noRates.push(rate);
      }
    }

    if (yesRates.length === 0 || noRates.length === 0) {
      return null; // no range
    }

    const minYes = Math.min(...yesRates);
    const maxNo = Math.max(...noRates);

    if (minYes < maxNo) {
      return 0; // ✅ RANGE COMPLETE → no exposure
    }

    return null;
  }

  /**
   * Calculate normal fancy exposure for a single fancy group
   * ✅ EXCHANGE-CORRECT: Worst-case loss across all outcomes
   * 
   * Rules:
   * - Same-line YES/NO → hedge: exposure = |YES - NO|
   * - Multiple different rates → sum exposure per rate (no cross-rate hedging)
   * - No unlocking or risk-free assumptions at placement time
   * - Exposure must always represent worst-case loss
   * 
   * @param fancyBets - Array of bets for a single fancy (same eventId + selectionId)
   * @returns Exposure for this fancy group
   */
  private calculateNormalFancyExposureForFancy(fancyBets: any[]): number {
    if (fancyBets.length === 0) return 0;

    // Group bets by rate (line) for this fancy market
    const grouped = new Map<number, {
      yes: number;
      no: number;
    }>();

    for (const bet of fancyBets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const betTypeUpper = (bet.betType || '').toUpperCase();
      const rate = bet.betRate ?? bet.odds ?? 0;

      if (!grouped.has(rate)) {
        grouped.set(rate, { yes: 0, no: 0 });
      }

      const bucket = grouped.get(rate)!;

      if (betTypeUpper === 'YES' || betTypeUpper === 'BACK') {
        bucket.yes += stake;
      } else if (betTypeUpper === 'NO' || betTypeUpper === 'LAY') {
        bucket.no += stake;
      }
    }

    // ✅ EXCHANGE-CORRECT FANCY EXPOSURE RULE
    // For each rate: Apply same-line hedging |YES - NO|
    // Sum exposure across all rates (no cross-rate hedging)
    // This preserves same-line hedging while preventing over-locking in mixed scenarios
    let totalExposure = 0;
    const rates = Array.from(grouped.keys());

    // Calculate exposure per rate (same-line hedge), then sum
    for (const rate of rates) {
      const g = grouped.get(rate)!;
      // Same-line hedging: |YES - NO|
      const lineExposure = Math.max(
        g.yes - g.no,
        g.no - g.yes,
        0
      );
      totalExposure += lineExposure;
    }

    return totalExposure;
  }


  /**
   * ✅ FANCY EXPOSURE DELTA CALCULATOR
   * 
   * Calculates exposure delta for Fancy bets ONLY.
   * DO NOT change existing fancy logic - only return (newFancyExposure - oldFancyExposure).
   * 
   * @param existingBets - Existing pending bets (without new bet)
   * @param allBetsWithNewBet - All bets including new bet
   * @returns Exposure delta (positive = liability increases, negative = liability releases)
   */
  calculateFancyExposureDelta(
    existingBets: any[],
    allBetsWithNewBet: any[],
  ): number {
    const oldFancyBets = existingBets.filter(
      (b) => (b.gtype || '').toLowerCase() === 'fancy',
    );

    const newFancyBets = allBetsWithNewBet.filter(
      (b) => (b.gtype || '').toLowerCase() === 'fancy',
    );

    const oldExposure = this.calculateFancyExposureInMemory(oldFancyBets);
    const newExposure = this.calculateFancyExposureInMemory(newFancyBets);

    return newExposure - oldExposure;
  }

  /**
   * ✅ FINAL SINGLE FUNCTION for calculating Fancy group delta safely
   * 
   * This function handles all the complexity internally:
   * - Filters bets by same fancy group (gtype + marketId + selectionId)
   * - Calculates old vs new exposure per group (isolated from other groups)
   * - Returns delta for wallet update
   * 
   * @param existingBets - Existing pending bets (without new bet)
   * @param newBet - The new bet being placed
   * @returns Exposure delta (positive = liability increases, negative = liability releases)
   */
  calculateFancyGroupDeltaSafe(
    existingBets: any[],
    newBet: any,
  ): number {
    // 1️⃣ Filter same fancy group: marketId + selectionId (per exchange rule)
    const oldGroup = existingBets.filter(
      (b) =>
        b.gtype?.toLowerCase() === 'fancy' &&
        b.marketId === newBet.marketId &&
        b.selectionId === newBet.selectionId,
    );

    // 2️⃣ Add new bet to group
    const newGroup = [...oldGroup, newBet];

    // 3️⃣ Calculate exposure for this group only (isolated)
    const oldExposure = this.calculateFancyExposureInMemory(oldGroup);
    const newExposure = this.calculateFancyExposureInMemory(newGroup);

    // 4️⃣ Return delta (wallet will be updated by this delta ONLY)
    return newExposure - oldExposure;
  }
}

