import { Injectable } from '@nestjs/common';

/**
 * ✅ BOOKMAKER EXPOSURE SERVICE
 * 
 * Handles all exposure calculations for Bookmaker markets.
 * Bookmaker exposure is isolated by marketId.
 */
@Injectable()
export class BookmakerExposureService {
  /**
   * Calculate Bookmaker exposure in memory (no database queries)
   * 
   * Bookmaker exposure = |totalBackStake - totalLayLiability|
   * 
   * @param bets - Array of bets for the market
   * @returns Net exposure for this Bookmaker market
   */
  calculateBookmakerExposureInMemory(bets: any[]): number {
    let totalBackStake = 0;
    let totalLayLiability = 0;

    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      const betTypeUpper = (bet.betType || '').toUpperCase();

      if (betTypeUpper === 'BACK') {
        totalBackStake += stake;
      } else if (betTypeUpper === 'LAY') {
        totalLayLiability += (odds - 1) * stake;
      }
    }

    return Math.abs(totalBackStake - totalLayLiability);
  }

  /**
   * ✅ BOOKMAKER EXPOSURE DELTA CALCULATOR
   * 
   * Calculates exposure delta for Bookmaker bets ONLY.
   * Bookmaker exposure is isolated by marketId.
   * 
   * @param existingBets - Existing pending bets (without new bet)
   * @param allBetsWithNewBet - All bets including new bet
   * @param marketId - Market ID to filter by
   * @returns Exposure delta (positive = liability increases, negative = liability releases)
   */
  calculateBookmakerExposureDelta(
    existingBets: any[],
    allBetsWithNewBet: any[],
    marketId: string,
  ): number {
    // Filter to only Bookmaker bets for this marketId
    const oldBM = existingBets.filter((bet) => {
      const betGtype = (bet.gtype || '').toLowerCase();
      return (
        betGtype === 'bookmaker' ||
        (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds')
      ) && bet.marketId === marketId;
    });

    const newBM = allBetsWithNewBet.filter((bet) => {
      const betGtype = (bet.gtype || '').toLowerCase();
      return (
        betGtype === 'bookmaker' ||
        (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds')
      ) && bet.marketId === marketId;
    });

    const oldExposure = this.calculateBookmakerExposureInMemory(oldBM);
    const newExposure = this.calculateBookmakerExposureInMemory(newBM);

    return newExposure - oldExposure;
  }
}

