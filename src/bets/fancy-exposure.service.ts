import { Injectable } from '@nestjs/common';

/**
 * ✅ FANCY EXPOSURE SERVICE
 * 
 * Handles all exposure calculations for Fancy markets.
 * Uses Maximum Possible Loss calculation model (market-correct approach).
 * 
 * Calculates exposure by simulating all possible outcomes and finding
 * the worst-case loss scenario across all Fancy bets.
 */
@Injectable()
export class FancyExposureService {
  /**
   * Maximum possible outcome value for Fancy markets
   * Used to bound the outcome simulation range
   */
  private readonly MAX_FANCY_OUTCOME = 1000;

  /**
   * Minimum possible outcome value for Fancy markets
   */
  private readonly MIN_FANCY_OUTCOME = 0;
  /**
   * Calculate Fancy exposure in memory using Maximum Possible Loss model
   * 
   * ✅ MARKET-CORRECT APPROACH:
   * - Simulates all possible outcomes (runs/score values)
   * - For each outcome, calculates total P/L across all bets
   * - Returns the maximum possible loss (worst-case scenario)
   * 
   * 
   * This approach is:
   * - Deterministic (same bets = same exposure)
   * - Idempotent (order-independent)
   * - Free from YES/NO or range heuristics
   * 
   * @param bets - Array of bets for Fancy markets (gtype === 'fancy')
   * @returns Maximum possible loss across all outcomes
   */
  calculateFancyExposureInMemory(bets: any[]): number {
    if (bets.length === 0) return 0;

    // Filter only Fancy bets
    const fancyBets = bets.filter(
      (bet) => (bet.gtype || '').toLowerCase() === 'fancy',
    );

    if (fancyBets.length === 0) return 0;

    // Group bets by fancy key (eventId + selectionId)
    // Each group is evaluated independently
    const betsByFancy = new Map<string, any[]>();

    for (const bet of fancyBets) {
      const eventId = bet.eventId || '';
      const selectionId = bet.selectionId || 0;
      const fancyKey = `${eventId}_${selectionId}`;

      if (!betsByFancy.has(fancyKey)) {
        betsByFancy.set(fancyKey, []);
      }
      betsByFancy.get(fancyKey)!.push(bet);
    }

    // Calculate maximum loss per fancy group, then sum
    let totalExposure = 0;

    for (const fancyBets of betsByFancy.values()) {
      const maxLoss = this.calculateFancyMaxLoss(fancyBets);
      totalExposure += maxLoss;
    }

    return totalExposure;
  }

  /**
   * Calculate Maximum Possible Loss for a group of Fancy bets
   * 
   * Simulates all possible outcomes and finds the worst-case loss.
   * 
   * @param fancyBets - Array of bets for a single Fancy market (same eventId + selectionId)
   * @returns Maximum possible loss (always >= 0)
   */
  private calculateFancyMaxLoss(fancyBets: any[]): number {
    if (fancyBets.length === 0) return 0;

    // Determine outcome range based on bet rates
    // Use bet rates to determine reasonable outcome range
    const allRates: number[] = [];
    for (const bet of fancyBets) {
      const rate = bet.betRate ?? bet.odds ?? 0;
      if (rate > 0) {
        allRates.push(rate);
      }
    }

    // Determine outcome range: from min(0, minRate - buffer) to max(maxRate + buffer, MAX_FANCY_OUTCOME)
    const minRate = allRates.length > 0 ? Math.min(...allRates) : 0;
    const maxRate = allRates.length > 0 ? Math.max(...allRates) : this.MAX_FANCY_OUTCOME;
    const buffer = Math.max(50, maxRate * 0.2); // 20% buffer or minimum 50

    const minOutcome = Math.max(this.MIN_FANCY_OUTCOME, Math.floor(minRate - buffer));
    const maxOutcome = Math.min(this.MAX_FANCY_OUTCOME, Math.ceil(maxRate + buffer));

    // Simulate each possible outcome and calculate total P/L
    let maxLoss = 0;

    for (let actualRuns = minOutcome; actualRuns <= maxOutcome; actualRuns++) {
      const totalPl = this.calculateTotalPlForOutcome(fancyBets, actualRuns);
      
      // Loss is negative P/L, so maximum loss is the absolute value of the most negative P/L
      if (totalPl < 0) {
        maxLoss = Math.max(maxLoss, Math.abs(totalPl));
      }
    }

    return maxLoss;
  }

  /**
   * Calculate total P/L for a specific outcome (actualRuns value)
   * 
   * @param fancyBets - Array of Fancy bets
   * @param actualRuns - The actual outcome value (runs/score)
   * @returns Total P/L (positive = profit, negative = loss)
   */
  // private calculateTotalPlForOutcome(fancyBets: any[], actualRuns: number): number {
  //   let totalPl = 0;

  //   for (const bet of fancyBets) {
  //     const betType = (bet.betType || '').toUpperCase();
  //     const line = bet.betRate ?? bet.odds ?? 0;
  //     const stake = bet.betValue ?? bet.amount ?? 0;
  //     const winAmount = bet.winAmount ?? stake;
  //     const lossAmount = bet.lossAmount ?? stake;

  //     const isYes = betType === 'YES' || betType === 'BACK';
  //     const isNo = betType === 'NO' || betType === 'LAY';

  //     let betWins = false;

  //     if (isYes) {
  //       // YES/BACK: Win if actualRuns >= line
  //       betWins = actualRuns >= line;
  //     } else if (isNo) {
  //       // NO/LAY: Win if actualRuns < line
  //       betWins = actualRuns < line;
  //     }

  //     // Calculate P/L for this bet
  //     if (betWins) {
  //       // Bet wins: profit = winAmount
  //       totalPl += winAmount;
  //     } else {
  //       // Bet loses: loss = -lossAmount
  //       totalPl -= lossAmount;
  //     }
  //   }

  //   return totalPl;
  // }
  private calculateTotalPlForOutcome(
    fancyBets: any[],
    actualRuns: number,
  ): number {
    let totalPl = 0;
  
    for (const bet of fancyBets) {
      const betType = (bet.betType || '').toUpperCase();
      const line = bet.betRate ?? bet.odds ?? 0;
  
      // ✅ Fancy stake is the ONLY value that matters
      const stake = bet.betValue ?? bet.amount ?? 0;
  
      const isYes = betType === 'YES' || betType === 'BACK';
      const isNo = betType === 'NO' || betType === 'LAY';
  
      let betWins = false;
  
      if (isYes) {
        // YES / BACK wins if actualRuns >= line
        betWins = actualRuns >= line;
      } else if (isNo) {
        // NO / LAY wins if actualRuns < line
        betWins = actualRuns < line;
      }
  
      // ✅ FANCY P/L RULE
      if (betWins) {
        // Profit = +stake (NOT winAmount, NOT odds)
        totalPl += stake;
      } else {
        // Loss = -stake
        totalPl -= stake;
      }
    }
  
    return totalPl;
  }
  
  /**
   * @deprecated - Replaced by calculateFancyMaxLoss (Maximum Possible Loss model)
   * Kept for reference only - not used in active code path
   */
  private applyRangeFancyPolicyForFancy(fancyBets: any[]): number | null {
    // DEPRECATED: Range detection logic removed in favor of Maximum Possible Loss calculation
    return null;
      }

  /**
   * @deprecated - Replaced by calculateFancyMaxLoss (Maximum Possible Loss model)
   * Kept for reference only - not used in active code path
   */
  private calculateNormalFancyExposureForFancy(fancyBets: any[]): number {
    // DEPRECATED: Normal fancy exposure logic removed in favor of Maximum Possible Loss calculation
    return 0;
  }


  /**
   * ✅ FANCY EXPOSURE DELTA CALCULATOR
   * 
   * Calculates exposure delta for Fancy bets using Maximum Possible Loss model.
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
   * ✅ Calculate Fancy group delta using Maximum Possible Loss model
   * 
   * This function:
   * - Filters bets by same fancy group (gtype + marketId + selectionId)
   * - Calculates old vs new exposure per group using Maximum Possible Loss
   * - Returns delta for wallet update
   * 
   * @param existingBets - Existing pending bets (without new bet)
   * @param newBet - The new bet being placed
   * @returns Object with delta (isRangeConsumed is always false in new model)
   */
  calculateFancyGroupDeltaSafe(
    existingBets: any[],
    newBet: any,
  ): { delta: number; isRangeConsumed: boolean } {
    // 1️⃣ Filter same fancy group: marketId + selectionId (per exchange rule)
    const oldGroup = existingBets.filter(
      (b) =>
        b.gtype?.toLowerCase() === 'fancy' &&
        b.marketId === newBet.marketId &&
        b.selectionId === newBet.selectionId,
    );

    // 2️⃣ Add new bet to group
    const newGroup = [...oldGroup, newBet];

    // 3️⃣ Calculate exposure for this group only using Maximum Possible Loss
    const oldExposure = this.calculateFancyExposureInMemory(oldGroup);
    const newExposure = this.calculateFancyExposureInMemory(newGroup);

    // 4️⃣ Return delta (isRangeConsumed is deprecated in Maximum Possible Loss model)
    return {
      delta: newExposure - oldExposure,
      isRangeConsumed: false, // No longer used - Maximum Possible Loss handles all scenarios
    };
  }
}

