import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus, MatchStatus, TransactionType, Prisma, Wallet, Bet } from '@prisma/client';
import { 
  calculatePositions, 
  calculateMatchOddsPosition, 
  calculateBookmakerPosition,
  calculateFancyPosition,
} from '../positions/position.service';
import { CricketIdService } from '../cricketid/cricketid.service';

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cricketIdService: CricketIdService,
  ) {}

  /**
   * ✅ EXCHANGE-ACCURATE LIABILITY CALCULATION
   * 
   * Official Exchange Rules:
   * - FANCY: liability = stake (for both BACK and LAY)
   * - MATCH ODDS & BOOKMAKER: 
   *   - BACK: liability = stake
   *   - LAY: liability = (odds - 1) × stake
   * 
   * @param gtype - Market type: 'fancy' | 'bookmaker' | 'matchodds'
   * @param betType - Bet type: 'BACK' | 'LAY'
   * @param stake - Stake amount
   * @param odds - Odds/rate
   * @returns Liability amount
   */
  private calculateLiability(
    gtype: string | null | undefined,
    betType: string | null | undefined,
    stake: number,
    odds: number,
  ): number {
    const normalizedGtype = (gtype || '').toLowerCase();
    const normalizedBetType = (betType || '').toUpperCase();

    // FANCY: liability = stake (for both BACK and LAY)
    if (normalizedGtype === 'fancy') {
      return stake;
    }

    // MATCH ODDS & BOOKMAKER: LAY uses (odds - 1) × stake, BACK uses stake
    if (normalizedBetType === 'LAY') {
      return (odds - 1) * stake;
    }
    // BACK bet (match odds/bookmaker) or fallback
    return stake;
  }

  private buildMatchOddsPositions(bets: any[]) {
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
        pos.win += profit;   // if wins
        pos.lose -= stake;  // if loses
      }
  
      if (type === 'LAY') {
        pos.win -= profit;  // if wins (liability)
        pos.lose += stake; // if loses (stake kept)
      }
    }
  
    return map;
  }
  
   
  private calculateExposureByMarketType(bets: any[]): {
    matchOdds: number;
    fancy: number;
    bookmaker: number;
    total: number;
  } {
    // Group bets by market type for efficient calculation
    const matchOddsBetsByMarket = new Map<string, typeof bets>();
    const bookmakerBetsByMarket = new Map<string, typeof bets>();
    const fancyBetsBySelection = new Map<string, typeof bets>();

    for (const bet of bets) {
      const betGtype = (bet.gtype || '').toLowerCase();
      
      // Match Odds bets
      if ((betGtype === 'matchodds' || betGtype === 'match') && bet.marketId) {
        if (!matchOddsBetsByMarket.has(bet.marketId)) {
          matchOddsBetsByMarket.set(bet.marketId, []);
        }
        matchOddsBetsByMarket.get(bet.marketId)!.push(bet);
      }
      // Bookmaker bets (including match1, match2, etc.)
      else if (
        bet.marketId &&
        (betGtype === 'bookmaker' ||
         (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds'))
      ) {
        if (!bookmakerBetsByMarket.has(bet.marketId)) {
          bookmakerBetsByMarket.set(bet.marketId, []);
        }
        bookmakerBetsByMarket.get(bet.marketId)!.push(bet);
      }
      // Fancy bets
      else if (betGtype === 'fancy' && bet.eventId && bet.selectionId) {
        const key = `${bet.eventId}_${bet.selectionId}`;
        if (!fancyBetsBySelection.has(key)) {
          fancyBetsBySelection.set(key, []);
        }
        fancyBetsBySelection.get(key)!.push(bet);
      }
    }

    let matchOddsExposure = 0;
    let bookmakerExposure = 0;
    let fancyExposure = 0;

    // Calculate Match Odds exposure (sum across all Match Odds markets)
    for (const [, marketBets] of matchOddsBetsByMarket) {
      matchOddsExposure += this.calculateMatchOddsExposureInMemory(marketBets);
    }

    // Calculate Bookmaker exposure (sum across all Bookmaker markets)
    for (const [, marketBets] of bookmakerBetsByMarket) {
      bookmakerExposure += this.calculateBookmakerExposureInMemory(marketBets);
    }

    // Calculate Fancy exposure (sum across all Fancy selections)
    for (const [, selectionBets] of fancyBetsBySelection) {
      fancyExposure += this.calculateFancyExposureInMemory(selectionBets);
    }

    // Calculate total exposure (sum of all market types)
    const total = matchOddsExposure + fancyExposure + bookmakerExposure;

    return {
      matchOdds: matchOddsExposure,
      fancy: fancyExposure,
      bookmaker: bookmakerExposure,
      total,
    };
  }

  private async calculateTotalExposure(tx: any, userId: string): Promise<number> {
    try {
      // ✅ OPTIMIZED: Fetch ALL pending bets in a single query to avoid transaction timeout
      // This reduces N+1 queries from potentially dozens to just 1 query
      const allBets = await tx.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
        },
        select: {
          gtype: true,
          marketId: true,
          eventId: true,
          selectionId: true,
          betType: true,
          winAmount: true,
          lossAmount: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
        },
      });

      // Group bets by market type for efficient calculation
      const matchOddsBetsByMarket = new Map<string, typeof allBets>();
      const bookmakerBetsByMarket = new Map<string, typeof allBets>();
      const fancyBetsBySelection = new Map<string, typeof allBets>();

      for (const bet of allBets) {
        const betGtype = (bet.gtype || '').toLowerCase();
        
        // Match Odds bets
        if ((betGtype === 'matchodds' || betGtype === 'match') && bet.marketId) {
          if (!matchOddsBetsByMarket.has(bet.marketId)) {
            matchOddsBetsByMarket.set(bet.marketId, []);
          }
          matchOddsBetsByMarket.get(bet.marketId)!.push(bet);
        }
        // Bookmaker bets (including match1, match2, etc.)
        else if (
          bet.marketId &&
          (betGtype === 'bookmaker' ||
           (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds'))
        ) {
          if (!bookmakerBetsByMarket.has(bet.marketId)) {
            bookmakerBetsByMarket.set(bet.marketId, []);
          }
          bookmakerBetsByMarket.get(bet.marketId)!.push(bet);
        }
        // Fancy bets
        else if (betGtype === 'fancy' && bet.eventId && bet.selectionId) {
          const key = `${bet.eventId}_${bet.selectionId}`;
          if (!fancyBetsBySelection.has(key)) {
            fancyBetsBySelection.set(key, []);
          }
          fancyBetsBySelection.get(key)!.push(bet);
        }
      }

      let totalExposure = 0;

      // Calculate Match Odds exposure (in memory, no additional queries)
      for (const [marketId, bets] of matchOddsBetsByMarket) {
        totalExposure += this.calculateMatchOddsExposureInMemory(bets);
      }

      // Calculate Bookmaker exposure (in memory, no additional queries)
      for (const [marketId, bets] of bookmakerBetsByMarket) {
        totalExposure += this.calculateBookmakerExposureInMemory(bets);
      }

      // Calculate Fancy exposure (in memory, no additional queries)
      for (const [key, bets] of fancyBetsBySelection) {
        totalExposure += this.calculateFancyExposureInMemory(bets);
      }

      return totalExposure;
    } catch (error: any) {
      // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
      if (error?.message?.includes('Transaction not found') || 
          error?.message?.includes('Transaction ID is invalid') ||
          error?.message?.includes('Transaction already closed')) {
        this.logger.warn(
          `Transaction invalid in calculateTotalExposure for userId: ${userId}. Returning 0 exposure.`,
        );
        return 0;
      }
      // Re-throw other errors
      throw error;
    }
  }

 

  // private calculateMatchOddsExposureInMemory(bets: any[]): number {
  //   if (!bets.length) return 0;
  
  //   /**
  //    * Build position map per selection
  //    * win  = Net PnL if this selection wins
  //    * lose = Net PnL if this selection loses
  //    * 
  //    * BACK and LAY bets on the same selection automatically offset here:
  //    * - BACK adds to win, subtracts from lose
  //    * - LAY subtracts from win, adds to lose
  //    */
  //   const positionBySelection = new Map<number, { win: number; lose: number }>();
  
  //   // Aggregate all bets per selection to enable automatic offset
  //   for (const bet of bets) {
  //     // Support both camelCase and snake_case field names
  //     const selectionId = Number(bet.selectionId ?? bet.selection_id ?? 0);
  //     if (!selectionId) continue;
  
  //     const stake = Number(bet.betValue ?? bet.betvalue ?? bet.amount ?? 0);
  //     const odds = Number(bet.betRate ?? bet.bet_rate ?? bet.odds ?? 0);
  //     const type = String(bet.betType ?? bet.bet_type ?? '').toUpperCase();
  
  //     if (!positionBySelection.has(selectionId)) {
  //       positionBySelection.set(selectionId, { win: 0, lose: 0 });
  //     }
  
  //     const pos = positionBySelection.get(selectionId)!;
  //     const profit = (odds - 1) * stake;
  
  //     // BACK bet: if wins → profit, if loses → lose stake
  //     if (type === 'BACK') {
  //       pos.win += profit;    // wins → profit = (odds - 1) * stake
  //       pos.lose -= stake;   // loses → stake lost
  //     }
  
  //     // LAY bet: if wins → lose profit (pay liability), if loses → keep stake
  //     if (type === 'LAY') {
  //       pos.win -= profit;   // wins → liability paid = (odds - 1) * stake
  //       pos.lose += stake;  // loses → stake gained (we keep the stake)
  //     }
  //   }
  
  //   // ✅ EXCHANGE LOGIC: Simulate each possible outcome (each selection winning)
  //   // Match Odds markets have multiple selections (runners)
  //   // We need to check what happens if each selection wins
  //   let exposure = 0;
  //   const selections = Array.from(positionBySelection.keys());
  
  //   for (const winner of selections) {
  //     // Calculate total PnL if this selection wins
  //     let pnl = 0;
  
  //     for (const [sid, pos] of positionBySelection) {
  //       // If this selection wins, use its win position
  //       // All other selections lose, use their lose positions
  //       pnl += sid === winner ? pos.win : pos.lose;
  //     }
  
  //     // Exposure = maximum absolute negative PnL
  //     // If PnL is negative, that's a loss scenario
  //     if (pnl < 0) {
  //       exposure = Math.max(exposure, Math.abs(pnl));
  //     }
  //   }
  
  //   // ✅ PURE EXCHANGE LOGIC: No safety floors, no stake forcing, no overrides
  //   // Exposure is determined SOLELY by worst-case PnL simulation
  //   // Offset works automatically through position aggregation (BACK + LAY offset)
  //   // Order-independent: BACK→LAY and LAY→BACK produce identical results
  //   // If fully hedged (BACK + LAY on same selection), exposure = 0 automatically
  
  //   return exposure;
  // }
  private calculateMatchOddsExposureInMemory(bets: any[]): number {
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
   * ✅ PURE EXCHANGE-STYLE MATCH ODDS EXPOSURE CALCULATION
   * 
   * Calculates exposure using worst-case PnL simulation across all possible outcomes.
   * 
   * EXCHANGE RULES:
   * - Exposure = maximum possible loss across all selections in the market
   * - Offset = automatic reduction of exposure (BACK + LAY on same selection)
   * - No safety floors, no stake forcing, pure PnL-based calculation
   * 
   * ALGORITHM:
   * 1. Build position map per selection: { win: PnL if wins, lose: PnL if loses }
   * 2. For each possible winner, calculate total PnL
   * 3. Exposure = maximum absolute negative PnL across all outcomes
   * 
   * @param bets - Array of bets for this Match Odds market
   * @returns Net exposure (worst-case loss) for this market
   */
  // private calculateMatchOddsExposureInMemory(bets: any[]): number {
  //   if (!bets.length) return 0;
  
  //   // Build position map per selection
  //   const positionBySelection = new Map<number, { win: number; lose: number }>();
  
  //   for (const bet of bets) {
  //     if (!bet.selectionId) continue;
  
  //     const stake = Number(bet.betValue || bet.amount || 0);
  //     const odds = Number(bet.betRate || bet.odds || 0);
  //     const type = (bet.betType || '').toUpperCase();
  
  //     if (!positionBySelection.has(bet.selectionId)) {
  //       positionBySelection.set(bet.selectionId, { win: 0, lose: 0 });
  //     }
  
  //     const pos = positionBySelection.get(bet.selectionId)!;
  //     const profit = (odds - 1) * stake;
  
  //     // BACK bet: if wins → profit, if loses → lose stake
  //     if (type === 'BACK') {
  //       pos.win += profit;
  //       pos.lose -= stake;
  //     }
  
  //     // LAY bet: if wins → lose profit, if loses → keep stake
  //     if (type === 'LAY') {
  //       pos.win -= profit;
  //       pos.lose += stake;
  //     }
  //   }
  
  //   // Calculate exposure = maximum possible loss across all outcomes
  //   let exposure = 0;
  //   const allSelections = Array.from(positionBySelection.keys());
  
  //   // Check each possible outcome (each selection winning)
  //   // This covers all cases where a selection with bets wins
  //   for (const winner of allSelections) {
  //     let pnl = 0;
      
  //     for (const [sid, pos] of positionBySelection) {
  //       // If this selection wins, use win position; otherwise use lose position
  //       pnl += sid === winner ? pos.win : pos.lose;
  //     }
      
  //     // Exposure = maximum absolute negative PnL
  //     if (pnl < 0) {
  //       exposure = Math.max(exposure, Math.abs(pnl));
  //     }
  //   }
    
  //   // 🔐 CRITICAL: Also check what happens if ALL selections with bets lose
  //   // This handles cases where the winner is NOT in positionBySelection (no bets on winner)
  //   // When Selection A loses, Selection B (or C, etc.) wins
  //   // If the winner has no bets, its positions are 0, so pnl = sum of all losers' positions
  //   // We only need to check this once (not per loserId) since it's the same for all
  //   let pnlIfWinnerNotInMap = 0;
  //   for (const [sid, pos] of positionBySelection) {
  //     // All selections with bets lose when winner is not in map
  //     pnlIfWinnerNotInMap += pos.lose;
  //   }
    
  //   // Exposure = maximum absolute negative PnL
  //   if (pnlIfWinnerNotInMap < 0) {
  //     exposure = Math.max(exposure, Math.abs(pnlIfWinnerNotInMap));
  //   }
  
  //   // ✅ PURE EXCHANGE LOGIC: No safety floors, no stake forcing
  //   // Exposure is determined solely by worst-case PnL simulation
  //   // Offset works automatically through PnL calculation (BACK + LAY on same selection offset)
  
  //   return exposure;
  // }
  // private calculateMatchOddsExposureInMemory(bets: any[]): number {
  //   if (!bets.length) return 0;
  
  //   const pos = new Map<number, { win: number; lose: number }>();
  
  //   for (const bet of bets) {
  //     const selectionId = Number(bet.selectionId ?? bet.selection_id);
  //     if (!selectionId) continue;
  
  //     const stake = Number(bet.betvalue ?? bet.betValue ?? bet.amount ?? 0);
  //     const odds = Number(bet.bet_rate ?? bet.betRate ?? bet.odds ?? 0);
  //     const type = String(bet.bet_type ?? bet.betType).toUpperCase();
  
  //     if (!pos.has(selectionId)) {
  //       pos.set(selectionId, { win: 0, lose: 0 });
  //     }
  
  //     const p = pos.get(selectionId)!;
  
  //     if (type === 'BACK') {
  //       p.win += (odds - 1) * stake;
  //       p.lose -= stake;
  //     } else if (type === 'LAY') {
  //       p.win -= (odds - 1) * stake; // liability
  //       p.lose += stake;            // stake gained
  //     }
  //   }
  
  //   let worstPnl = 0;
  
  //   for (const winner of pos.keys()) {
  //     let pnl = 0;
  
  //     for (const [sid, p] of pos) {
  //       pnl += sid === winner ? p.win : p.lose;
  //     }
  
  //     if (pnl < worstPnl) {
  //       worstPnl = pnl;
  //     }
  //   }
  
  //   return Math.abs(worstPnl);
  // }
  
  
  
  

  /**
   * Calculate Bookmaker exposure in memory (no database queries)
   * @param bets - Array of bets for the market
   * @returns Net exposure for this Bookmaker market
   */
  private calculateBookmakerExposureInMemory(bets: any[]): number {
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
   * Calculate Fancy exposure in memory (no database queries)
   * ✅ EXCHANGE RULE: Different lines do NOT hedge, only same-line reverse can reduce exposure
   * - Group bets by eventId_selectionId_rate (same-line grouping)
   * - Same-line: YES @ X and NO @ X hedge each other (exposure = |YES - NO|)
   * - Different lines: YES @ A + NO @ B = full liability (sum, NO hedge)
   * - Exposure is net per line, then summed across all lines
   * 
   * ✅ GOLA FANCY SUPPORT (OPTION-A: Backend-Driven Detection):
   * - Gola pattern auto-detected from bet patterns (YES rate < NO rate)
   * - No frontend metadata dependency
   * - Only ONE outcome can win, all other outcomes lose
   * - Exposure = worst-case loss across all possible score outcomes
   * 
   * @param bets - Array of bets for the fancy selection
   * @returns Net exposure for this Fancy selection
   */
  private calculateFancyExposureInMemory(bets: any[]): number {
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
    for (const [fancyKey, fancyBets] of betsByFancy) {
      // OPTION-A: Pure backend-driven gola detection (no frontend metadata dependency)
      const hasGolaPattern = this.detectGolaGroups(fancyBets);
      
      if (hasGolaPattern) {
        // Calculate using Gola Fancy worst-case rules
        const golaResult = this.calculateGolaFancyExposureForFancy(fancyBets);
        totalExposure += golaResult.maxLoss;
      } else {
        // Calculate using normal fancy exposure logic
        totalExposure += this.calculateNormalFancyExposureForFancy(fancyBets);
      }
    }

    return totalExposure;
  }

  /**
   * Pure Gola detection (no mutation, no removal)
   * 
   * Detects if a fancy group has gola pattern:
   * - Same fancy: eventId + selectionId must match (already grouped by caller)
   * - Opposite bet types: YES at one rate, NO at another rate
   * - Valid gola: YES rate < NO rate (creates a range)
   * 
   * @param fancyBets - Array of bets for a single fancy (same eventId + selectionId)
   * @returns true if gola pattern exists, false otherwise
   */
  private detectGolaGroups(fancyBets: any[]): boolean {
    if (fancyBets.length === 0) return false;

    // Separate YES and NO bets by rate
    const yesRates = new Set<number>();
    const noRates = new Set<number>();

    for (const bet of fancyBets) {
      const rate = bet.betRate ?? bet.odds ?? 0;
      const type = (bet.betType || '').toUpperCase();

      if (type === 'YES' || type === 'BACK') {
        yesRates.add(rate);
      } else if (type === 'NO' || type === 'LAY') {
        noRates.add(rate);
      }
    }

    // Gola exists if there's at least one YES rate < at least one NO rate
    for (const yesRate of yesRates) {
      for (const noRate of noRates) {
        if (yesRate < noRate) {
          return true;
        }
      }
    }

    return false;
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
   * Calculate Gola Fancy exposure for a single fancy group (worst-case loss)
   * 
   * GOLA RULE: Only ONE outcome can win, all others lose
   * 
   * WORST-CASE EXPOSURE CALCULATION:
   * - Check all possible score outcomes
   * - For each score:
   *   - If score < lowest YES rate → all YES lose, all NO win
   *   - If score > highest NO rate → all YES win, all NO lose
   *   - If score is between → YES above score + NO below score lose
   * - Exposure = MAX(total loss across all score outcomes)
   * 
   * @param fancyBets - Array of bets for a single fancy (same eventId + selectionId)
   * @returns Object containing maxLoss and deltaMap (rate => potential loss delta)
   */
  private calculateGolaFancyExposureForFancy(fancyBets: any[]): { maxLoss: number, deltaMap: Map<string, number> } {
    if (fancyBets.length === 0) return { maxLoss: 0, deltaMap: new Map() };

    const yesByRate = new Map<number, number>();
    const noByRate = new Map<number, number>();

    for (const bet of fancyBets) {
      const rate = bet.betRate ?? bet.odds ?? 0;
      const stake = bet.betValue ?? bet.amount ?? 0;
      const type = (bet.betType || '').toUpperCase();

      if (type === 'YES' || type === 'BACK') {
        yesByRate.set(rate, (yesByRate.get(rate) || 0) + stake);
      } else if (type === 'NO' || type === 'LAY') {
        noByRate.set(rate, (noByRate.get(rate) || 0) + stake);
      }
    }

    const yesRates = Array.from(yesByRate.keys()).sort((a, b) => a - b);
    const noRates = Array.from(noByRate.keys()).sort((a, b) => a - b);

    if (yesRates.length === 0 || noRates.length === 0) {
      const normalExposure = this.calculateNormalFancyExposureForFancy(fancyBets);
      return { maxLoss: normalExposure, deltaMap: new Map() };
    }

    const totalYesStake = Array.from(yesByRate.values()).reduce((sum, s) => sum + s, 0);
    const totalNoStake = Array.from(noByRate.values()).reduce((sum, s) => sum + s, 0);

    const minYesRate = Math.min(...yesRates);
    const maxNoRate = Math.max(...noRates);

    let maxLoss = 0;
    const deltaMap = new Map<string, number>(); // rate => potential loss delta

    const allRates = [...new Set([...yesRates, ...noRates])].sort((a, b) => a - b);

    const calculateLossAtScore = (score: number) => {
      let loss = 0;
      for (const [rate, stake] of yesByRate) {
        if (rate > score) loss += stake;
      }
      for (const [rate, stake] of noByRate) {
        if (rate < score) loss += stake;
      }
      return loss;
    };

    // Check boundary scenarios
    maxLoss = Math.max(maxLoss, totalYesStake); // score < minYesRate
    deltaMap.set(`below_${minYesRate}`, totalYesStake);

    maxLoss = Math.max(maxLoss, totalNoStake); // score > maxNoRate
    deltaMap.set(`above_${maxNoRate}`, totalNoStake);

    // Check all score boundaries
    for (const score of allRates) {
      if (score <= minYesRate || score >= maxNoRate) continue;
      const loss = calculateLossAtScore(score);
      maxLoss = Math.max(maxLoss, loss);
      deltaMap.set(`score_${score}`, loss);
    }

    // Check midpoints between rates
    for (let i = 0; i < allRates.length - 1; i++) {
      const midpoint = (allRates[i] + allRates[i + 1]) / 2;
      if (midpoint <= minYesRate || midpoint >= maxNoRate) continue;
      const loss = calculateLossAtScore(midpoint);
      maxLoss = Math.max(maxLoss, loss);
      deltaMap.set(`mid_${midpoint}`, loss);
    }

    return { maxLoss, deltaMap };
  }
  

  async selectOneRow(table: string, idField: string, userId: string) {
    // OPTIMIZED: Parallel fetch user and wallet
    const [user, wallet] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          isActive: true,
        },
      }),
      this.prisma.wallet.findUnique({
        where: { userId },
        select: {
          balance: true,
        },
      }),
    ]);

    if (!user) {
      throw new HttpException(
        {
          success: false,
          error: `User not found. Please ensure the user with ID '${userId}' exists in the system before placing bets.`,
          code: 'USER_NOT_FOUND',
        },
        404,
      );
    }

    // Return wallet balance as available credit (not profit/loss)
    // Balance represents usable credit from top-ups, not earnings
    return {
      fs_id: userId,
      status: user.isActive ? 1 : 3,
      sports_exp: wallet?.balance ?? 0, // Available credit for betting
    };
  }

 


  // ---------------------------------- MAIN LOGIC (CENTRALIZED MASTER FUNCTION) ---------------------------------- //

  /**
   * ✅ VALIDATE RATE AVAILABILITY
   * Checks if the requested rate/odds is currently available in the market
   * 
   * @param eventId - Event ID
   * @param marketId - Market ID
   * @param marketType - Market type: 'matchodds' | 'fancy' | 'bookmaker'
   * @param requestedRate - The rate/odds being requested
   * @param selectionId - Selection ID (for match odds and fancy)
   * @param betType - Bet type: 'BACK' | 'LAY' (to match otype)
   * @throws HttpException if rate is not available
   */
  private async validateRateAvailability(
    eventId: string,
    marketId: string,
    marketType: string,
    requestedRate: number,
    selectionId: number,
    betType?: string,
  ): Promise<void> {
    try {
      // Both match odds and fancy are in getBookmakerFancy response
      const marketData = await this.cricketIdService.getBookmakerFancy(eventId);
      
      if (!marketData?.data || !Array.isArray(marketData.data)) {
        throw new HttpException(
          {
            success: false,
            error: 'Rate not matched',
            code: 'RATE_NOT_MATCHED',
          },
          400,
        );
      }

      // Determine expected market name and bet type
      const expectedMname = marketType === 'matchodds' ? 'MATCH_ODDS' : null;
      const expectedOtype = betType?.toUpperCase() === 'LAY' ? 'lay' : 'back';
      
      let rateFound = false;
      let marketFound = false;

      // Search through all markets
      for (const market of marketData.data) {
        const mname = (market.mname || '').toUpperCase();
        
        // For match odds: only check MATCH_ODDS market
        if (marketType === 'matchodds' && mname !== 'MATCH_ODDS') {
          continue;
        }
        
        // For fancy: skip MATCH_ODDS, Bookmaker, TIED_MATCH (only check Normal fancy)
        if (marketType === 'fancy') {
          if (mname === 'MATCH_ODDS' || mname === 'BOOKMAKER' || mname === 'TIED_MATCH') {
            continue;
          }
        }

        marketFound = true;

        // Check sections array
        if (market.section && Array.isArray(market.section)) {
          for (const section of market.section) {
            const sectionSid = Number(section.sid || 0);
            
            // For match odds and fancy: match by selectionId (sid)
            if (selectionId > 0 && sectionSid !== selectionId) {
              continue;
            }

            // Check odds array in this section
            if (section.odds && Array.isArray(section.odds)) {
              for (const odd of section.odds) {
                const availableRate = Number(odd.odds || 0);
                const oddOtype = (odd.otype || '').toLowerCase();
                
                // Check if rate matches and otype matches bet type
                if (availableRate > 0 && Math.abs(availableRate - requestedRate) < 0.01) {
                  // If betType is specified, also check otype matches
                  if (betType) {
                    if (oddOtype === expectedOtype) {
                      rateFound = true;
                      break;
                    }
                  } else {
                    // If betType not specified, accept any otype
                    rateFound = true;
                    break;
                  }
                }
              }
            }
            
            if (rateFound) break;
          }
        }
        
        if (rateFound) break;
      }

      if (!marketFound) {
        throw new HttpException(
          {
            success: false,
            error: `Rate not matched `,
            code: 'RATE_NOT_MATCHED',
          },
          400,
        );
      }

      if (!rateFound) {
        throw new HttpException(
          {
            success: false,
            error: `Rate not matched `,
            code: 'RATE_NOT_MATCHED',
          },
          400,
        );
      }
      // Note: Bookmaker markets validation can be added similarly if needed
    } catch (error) {
      // If it's already an HttpException, re-throw it
      if (error instanceof HttpException) {
        throw error;
      }
      
      // Log and wrap other errors
      this.logger.error(`Error validating rate availability:`, error);
      throw new HttpException(
        {
          success: false,
          error: 'Rate not matched ',
          code: 'RATE_VALIDATION_ERROR',
        },
        400,
      );
    }
  }

  /**
   * ✅ MASTER BET PLACEMENT FUNCTION (SINGLE SOURCE OF TRUTH)
   * 
   * This is the ONLY function that updates wallet and writes bets to DB.
   * 
   * ARCHITECTURAL RULES:
   * 1. Load wallet & all pending bets
   * 2. Snapshot OLD exposure by market type (oldMO, oldFancy, oldBM)
   * 3. Create new bet (in memory, add to bets array)
   * 4. Calculate NEW exposure by market type (newMO, newFancy, newBM)
   * 5. Compute delta = (oldMO + oldFancy + oldBM) - (newMO + newFancy + newBM)
   * 6. Update wallet: balance -= delta, liability += delta (if delta > 0)
   *    OR: balance += |delta|, liability += delta (if delta < 0, refund case)
   * 7. Write to DB atomically (bet + wallet)
   * 
   * 🔐 CRITICAL INVARIANT:
   * - wallet.liability MUST equal netExposure (matchOdds + fancy + bookmaker)
   * - Wallet updates ONLY via exposure delta calculation
   * - No helper function is allowed to modify wallet
   */
  async placeBet(input: PlaceBetDto) {
    const debug: Record<string, unknown> = {};

    const {
      selection_id,
      bet_type,
      user_id,
      bet_name,
      bet_rate,
      match_id,
      market_name,
      betvalue,
      market_type,
      win_amount,
      loss_amount,
      gtype,
      marketId,
      eventId,
      runner_name_2,
    } = input;

    const normalizedBetValue = Number(betvalue) || 0;
    const normalizedBetRate = Number(bet_rate) || 0;
    const normalizedSelectionId = Number(selection_id) || 0;
    
    // REAL CRICKET EXCHANGE RULES:
    // - FANCY: liability = stake (for both BACK and LAY)
    // - MATCH ODDS / BOOKMAKER:
    //   - BACK bet: liability = stake
    //   - LAY bet: liability = (odds - 1) * stake
    // - Loss amount = liability (for settlement purposes)
    // - Win amount = stake * odds for BACK, stake for LAY
    const isBackBet = bet_type?.toUpperCase() === 'BACK';
    const isLayBet = bet_type?.toUpperCase() === 'LAY';
    
    let normalizedWinAmount = Number(win_amount) || 0;
    
    // Calculate winAmount if not provided
    if (normalizedBetValue > 0 && normalizedBetRate > 0) {
      if (isBackBet) {
        // BACK bet: winAmount = stake * odds (total return)
        normalizedWinAmount = normalizedWinAmount || normalizedBetValue * normalizedBetRate;
      } else if (isLayBet) {
        // LAY bet: winAmount = stake (if bet wins, we keep the stake)
        normalizedWinAmount = normalizedWinAmount || normalizedBetValue;
      }
    }

    const selid = Math.floor(Math.random() * 90000000) + 10000000;
    const settlement_id = `${match_id}_${selection_id}`;

    // 1. USER VALIDATION
    const userId = String(user_id);
    const userRow = await this.selectOneRow('fasio_supplier', 'fs_id', userId);

    if (userRow.status == 3) {
      return {
        success: false,
        error: 'Account is locked. Betting is not allowed.',
        code: 'ACCOUNT_LOCKED',
      };
    }

    // 2. VALIDATE MARKET ID (REQUIRED FOR EXCHANGE EXPOSURE)
    if (!marketId) {
      throw new HttpException(
        {
          success: false,
          error: 'marketId is REQUIRED for exchange exposure calculation',
          code: 'MISSING_MARKET_ID',
        },
        400,
      );
    }

    // Determine market type
    const normalizedGtype = (gtype || '').toLowerCase();
    const marketName = (input.market_name || '').toLowerCase();
    let actualMarketType = normalizedGtype;
    
    // Handle "match1", "match2", etc. as bookmaker (numbered match markets are bookmaker)
    if (normalizedGtype.startsWith('match') && normalizedGtype !== 'match' && normalizedGtype !== 'matchodds') {
      actualMarketType = 'bookmaker';
    }
    // Fallback: Check market_name if gtype is ambiguous
    else if (!normalizedGtype || normalizedGtype === '') {
      if (marketName.includes('bookmaker')) {
        actualMarketType = 'bookmaker';
      } else if (marketName.includes('fancy')) {
        actualMarketType = 'fancy';
      } else if (marketName.includes('match odds') || marketName.includes('matchodds')) {
        actualMarketType = 'matchodds';
      }
    }

    // Handle "match" as alias for "matchodds"
    if (actualMarketType === 'matchodds' || actualMarketType === 'match') {
      actualMarketType = 'matchodds';
    }

    if (!['matchodds', 'fancy', 'bookmaker'].includes(actualMarketType)) {
      throw new HttpException(
        {
          success: false,
          error: `Unsupported market type: ${gtype}. Supported types: match/matchodds, match1/match2/etc (bookmaker), fancy, bookmaker`,
          code: 'UNSUPPORTED_MARKET_TYPE',
        },
        400,
      );
    }

    // Set gtype for bet based on actual market type
    let betGtype = 'matchodds';
    if (actualMarketType === 'fancy') {
      betGtype = 'fancy';
    } else if (actualMarketType === 'bookmaker') {
      betGtype = 'bookmaker';
    }

    // Calculate lossAmount based on market type
    let normalizedLossAmount = 0;

    // Fancy & Bookmaker keep old behavior
    if (betGtype === 'fancy' || betGtype === 'bookmaker') {
      normalizedLossAmount = this.calculateLiability(
        gtype,
        bet_type,
        normalizedBetValue,
        normalizedBetRate
      );
    }

    // Match Odds: lossAmount is ONLY for settlement, not exposure
    if (betGtype === 'matchodds') {
      normalizedLossAmount = isBackBet
        ? normalizedBetValue
        : (normalizedBetRate - 1) * normalizedBetValue;
    }

    // Calculate to_return after lossAmount is determined
    const to_return = normalizedWinAmount + normalizedLossAmount;

    this.logger.log(`Attempting to place bet for user ${userId}, match ${match_id}, selection ${normalizedSelectionId}, marketType: ${actualMarketType}`);

    // 3. VALIDATE RATE AVAILABILITY (before placing bet)
    if (eventId && normalizedBetRate > 0) {
      await this.validateRateAvailability(
        eventId,
        marketId,
        actualMarketType,
        normalizedBetRate,
        normalizedSelectionId,
        bet_type,
      );
    }

    try {
      // 🔐 STEP 1: Load wallet & ALL pending bets (SNAPSHOT STATE)
      const transactionResult = await this.prisma.$transaction(
        async (tx) => {
          // Ensure match exists
          await tx.match.upsert({
            where: { id: String(match_id) },
            update: {
              ...(eventId && { eventId }),
              ...(marketId && { marketId }),
            },
            create: {
              id: String(match_id),
              homeTeam: bet_name ?? 'Unknown',
              awayTeam: market_name ?? 'Unknown',
              startTime: new Date(),
              status: MatchStatus.LIVE,
              ...(eventId && { eventId }),
              ...(marketId && { marketId }),
            },
          });

          // Get or create wallet
          const wallet = await tx.wallet.upsert({
            where: { userId },
            update: {},
            create: {
              userId,
              balance: 0,
              liability: 0,
            },
          });

          let currentBalance = Number(wallet.balance) || 0;
          let currentLiability = Number(wallet.liability) || 0;

          // Load pending bets for THIS marketId ONLY (CRITICAL FIX)
          // Exchange rule: Exposure is locked per USER + MARKET ID, not per market type.
          // Match Odds of Match A ≠ Match Odds of Match B - they NEVER offset each other.
          const allPendingBets = await tx.bet.findMany({
            where: {
              userId,
              status: BetStatus.PENDING,
              marketId, // 🔥 CRITICAL: Filter by marketId to isolate exposure per market
            },
            select: {
              gtype: true,
              marketId: true,
              eventId: true,
              selectionId: true,
              betType: true,
              betValue: true,
              amount: true,
              betRate: true,
              odds: true,
              winAmount: true,
              lossAmount: true,
            },
          });

          // 🔐 STEP 2: Calculate OLD exposure snapshot (by market type)
          const oldExposure = this.calculateExposureByMarketType(allPendingBets);
          const oldNetExposure = oldExposure.matchOdds + oldExposure.fancy + oldExposure.bookmaker;

          debug.old_exposure = oldExposure;
          debug.old_net_exposure = oldNetExposure;

          // 🔐 STEP 3: Create new bet (IN MEMORY - add to bets array for NEW exposure calculation)
          // OPTION-A: Gola Fancy detection is backend-only (no metadata injection needed)
          const newBet = {
            gtype: betGtype,
            marketId,
            eventId: eventId || null,
            selectionId: normalizedSelectionId,
            betType: bet_type,
            betValue: normalizedBetValue,
            amount: normalizedBetValue,
            betRate: normalizedBetRate,
            odds: normalizedBetRate,
            winAmount: normalizedWinAmount,
            lossAmount: normalizedLossAmount,
          };

          // Add new bet to bets array for NEW exposure calculation
          const allPendingBetsWithNewBet = [...allPendingBets, newBet];

          // 🔐 STEP 4: Calculate NEW exposure snapshot (by market type)
          let newExposure = this.calculateExposureByMarketType(allPendingBetsWithNewBet);
          let newNetExposure = newExposure.matchOdds + newExposure.fancy + newExposure.bookmaker;

          // 🔐 STEP 4a: Gola Fancy exposure adjustment (OPTION-A: Backend-driven)
          if (actualMarketType === 'fancy' && eventId && normalizedSelectionId) {
            // Get all bets for THIS fancy (eventId + selectionId) including the new bet
            const fancyBetsForDetection = allPendingBetsWithNewBet.filter((bet: any) => {
              const betGtype = (bet.gtype || '').toLowerCase();
              return (
                betGtype === 'fancy' &&
                bet.eventId === eventId &&
                bet.selectionId === normalizedSelectionId
              );
            });

            // Detect Gola Fancy pattern (pure backend detection)
            const isGolaFancy = this.detectGolaGroups(fancyBetsForDetection);
            debug.fancy_gola_detected = isGolaFancy;

            if (isGolaFancy) {
              // ✅ Calculate worst-case exposure for Gola Fancy using dedicated function
              const golaResult = this.calculateGolaFancyExposureForFancy(fancyBetsForDetection);
              const golaExposure = golaResult.maxLoss;
              
              // Get all OTHER fancy bets (excluding this fancy) to calculate their exposure
              const otherFancyBets = allPendingBetsWithNewBet.filter((bet: any) => {
                const betGtype = (bet.gtype || '').toLowerCase();
                return (
                  betGtype === 'fancy' &&
                  !(bet.eventId === eventId && bet.selectionId === normalizedSelectionId)
                );
              });
              
              // Calculate exposure for other fancies
              const otherFancyExposure = this.calculateFancyExposureInMemory(otherFancyBets);
              
              // Replace fancy exposure: Gola exposure for this fancy + normal exposure for other fancies
              newExposure.fancy = golaExposure + otherFancyExposure;
              debug.fancy_gola_exposure = golaExposure;
              debug.fancy_other_exposure = otherFancyExposure;

              // Update net exposure
              newNetExposure = newExposure.matchOdds + newExposure.fancy + newExposure.bookmaker;
            }
          }

          debug.new_exposure = newExposure;
          debug.new_net_exposure = newNetExposure;

          // 🔹 Step: Gola Fancy liability adjustment BEFORE wallet update
          if (actualMarketType === 'fancy' && eventId) {
            // 1️⃣ Group bets per selectionId
            const fancyBetsBySelection = new Map<number, any[]>();
            for (const bet of allPendingBetsWithNewBet) {
              if ((bet.gtype || '').toLowerCase() !== 'fancy' || !bet.eventId) continue;
              if (bet.eventId !== eventId) continue; // Only bets for this eventId
              const selectionId = bet.selectionId;
              if (!selectionId) continue; // Skip if selectionId is null/undefined
              if (!fancyBetsBySelection.has(selectionId)) {
                fancyBetsBySelection.set(selectionId, []);
              }
              fancyBetsBySelection.get(selectionId)!.push(bet);
            }

            let totalDeltaLiability = 0;

            for (const [selId, bets] of fancyBetsBySelection) {
              // Calculate old exposure (without new bet)
              const oldBets = allPendingBets.filter(b => 
                (b.gtype || '').toLowerCase() === 'fancy' && 
                b.selectionId === selId && 
                b.eventId === eventId
              );
              const oldExposure = this.calculateFancyExposureInMemory(oldBets);

              // Calculate new Gola exposure (with new bet)
              const golaResult = this.calculateGolaFancyExposureForFancy(bets);
              const newExposure = golaResult.maxLoss;

              // Delta per selection
              const delta = newExposure - oldExposure;
              totalDeltaLiability += delta;
            }

            // Apply total delta to wallet/liability
            if (totalDeltaLiability !== 0) {
              const updatedBalance = totalDeltaLiability > 0
                ? currentBalance - totalDeltaLiability
                : currentBalance + Math.abs(totalDeltaLiability);
              const updatedLiability = currentLiability + totalDeltaLiability;

              await tx.wallet.update({
                where: { userId },
                data: { balance: updatedBalance, liability: updatedLiability },
              });

              // Update debug info
              debug.gola_liability_adjustment = {
                total_delta_liability: totalDeltaLiability,
                wallet_before: { balance: currentBalance, liability: currentLiability },
                wallet_after: { balance: updatedBalance, liability: updatedLiability },
                selections_processed: Array.from(fancyBetsBySelection.keys()),
              };

              currentBalance = updatedBalance;
              currentLiability = updatedLiability;
            }
          }

          // 🔐 STEP 5: Compute exposure delta (PER-MARKET)
          // Exchange rule: Exposure must be applied PER MARKET TYPE.
          // Match Odds, Fancy, and Bookmaker must NEVER offset each other.
          // If delta > 0: exposure increased (deduct from balance, add to liability)
          // If delta < 0: exposure decreased (refund to balance, reduce liability)
          let exposureDelta: number;
          
          if (actualMarketType === 'matchodds' || actualMarketType === 'match') {
            exposureDelta = newExposure.matchOdds - oldExposure.matchOdds;
          } else if (actualMarketType === 'fancy') {
            exposureDelta = newExposure.fancy - oldExposure.fancy;
          } else if (actualMarketType === 'bookmaker') {
            exposureDelta = newExposure.bookmaker - oldExposure.bookmaker;
          } else {
            // Fallback to net exposure (shouldn't happen with valid market types)
            exposureDelta = newNetExposure - oldNetExposure;
          }

          debug.exposure_delta = exposureDelta;
          debug.market_type = actualMarketType;
          debug.market_id = marketId;
          
          // 🔐 LOG exposure calculation for debugging
          this.logger.warn(
            `[EXPOSURE] marketId=${marketId}, type=${actualMarketType}, ` +
            `oldExposure: MO=${oldExposure.matchOdds}, F=${oldExposure.fancy}, BM=${oldExposure.bookmaker}, ` +
            `newExposure: MO=${newExposure.matchOdds}, F=${newExposure.fancy}, BM=${newExposure.bookmaker}, ` +
            `exposureDelta=${exposureDelta}`,
          );
          
          // Add market-specific exposure breakdowns for debugging (matching old format for compatibility)
          if (actualMarketType === 'matchodds' || actualMarketType === 'match') {
            debug.matchodds_old_exposure = oldExposure.matchOdds;
            debug.matchodds_new_exposure = newExposure.matchOdds;
            debug.matchodds_exposure_diff = newExposure.matchOdds - oldExposure.matchOdds;
          } else if (actualMarketType === 'fancy') {
            debug.fancy_old_exposure = oldExposure.fancy;
            debug.fancy_new_exposure = newExposure.fancy;
            debug.fancy_exposure_diff = newExposure.fancy - oldExposure.fancy;
            
            // OPTION-A: Backend-only Gola Fancy detection (no frontend metadata dependency)
            // Detect gola pattern from bet data: YES rate < NO rate
            if (eventId && normalizedSelectionId) {
              // Get all bets for this fancy (including the new bet) to detect gola pattern
              const fancyBetsForDetection = allPendingBetsWithNewBet.filter((bet: any) => {
                const betGtype = (bet.gtype || '').toLowerCase();
                return (
                  betGtype === 'fancy' &&
                  bet.eventId === eventId &&
                  bet.selectionId === normalizedSelectionId
                );
              });
              
              const isGolaFancy = this.detectGolaGroups(fancyBetsForDetection);
              debug.fancy_gola_detected = isGolaFancy;
            } else {
              debug.fancy_gola_detected = false;
            }
          } else if (actualMarketType === 'bookmaker') {
            debug.bookmaker_old_exposure = oldExposure.bookmaker;
            debug.bookmaker_new_exposure = newExposure.bookmaker;
            debug.bookmaker_exposure_diff = newExposure.bookmaker - oldExposure.bookmaker;
          }
          
          // Add current wallet state for debugging
          debug.current_balance = currentBalance;
          debug.current_liability = currentLiability;
          debug.new_total_exposure = newNetExposure;

          // 🔐 STEP 6: Validate balance (only if exposure is increasing)
          if (exposureDelta > 0 && currentBalance < exposureDelta) {
            const shortfall = exposureDelta - currentBalance;
            throw new Error(
              `Insufficient available balance. ` +
              `Balance: ${currentBalance}, Required: ${exposureDelta}, Shortfall: ${shortfall}. ` +
              `Current Liability: ${currentLiability}, Old Net Exposure: ${oldNetExposure.toFixed(2)}, New Net Exposure: ${newNetExposure.toFixed(2)}. ` +
              `Old Exposure Breakdown: MO=${oldExposure.matchOdds.toFixed(2)}, Fancy=${oldExposure.fancy.toFixed(2)}, BM=${oldExposure.bookmaker.toFixed(2)}. ` +
              `New Exposure Breakdown: MO=${newExposure.matchOdds.toFixed(2)}, Fancy=${newExposure.fancy.toFixed(2)}, BM=${newExposure.bookmaker.toFixed(2)}`,
            );
          }

          // 🔐 STEP 7a: Recalculate Fancy exposure for all lines in this fancy group
          if (actualMarketType === 'fancy' && eventId && normalizedSelectionId) {
            // Get all fancy bets for this eventId (including the new bet)
            const fancyBetsForAdjustment = allPendingBetsWithNewBet.filter(
              (bet) => (bet.gtype || '').toLowerCase() === 'fancy' && bet.eventId === eventId
            );

            // Recalculate worst-case exposure using the existing function
            const updatedFancyExposure = this.calculateFancyExposureInMemory(fancyBetsForAdjustment);

            // Compute delta change
            const deltaChange = updatedFancyExposure - oldExposure.fancy;

            // Update exposureDelta with recalculated delta
            exposureDelta = deltaChange;

            // Update newExposure.fancy to match recalculated exposure
            newExposure.fancy = updatedFancyExposure;

            // Update net exposure
            newNetExposure = newExposure.matchOdds + newExposure.fancy + newExposure.bookmaker;

            // Debug logging
            debug.fancy_exposure_recalculation = {
              old_fancy_exposure: oldExposure.fancy,
              updated_fancy_exposure: updatedFancyExposure,
              delta_change: deltaChange,
              exposure_delta_updated: exposureDelta,
              fancy_bets_count: fancyBetsForAdjustment.length,
            };
          }

          // 🔐 STEP 7b: Update wallet using recalculated delta
          const newBalance = exposureDelta > 0
            ? currentBalance - exposureDelta
            : currentBalance + Math.abs(exposureDelta);
          const newLiability = currentLiability + exposureDelta;

          // Debug log before updating wallet
          debug.wallet_before = { balance: currentBalance, liability: currentLiability };
          debug.wallet_after = { balance: newBalance, liability: newLiability };

          // Update wallet atomically
          await tx.wallet.update({
            where: { userId },
            data: {
              balance: newBalance,
              liability: newLiability,
            },
          });

          // 🔐 STEP 8: Create bet record
          const betData: any = {
            userId,
            matchId: String(match_id),
            amount: normalizedBetValue,
            odds: normalizedBetRate,
            selectionId: normalizedSelectionId,
            betType: bet_type,
            betName: bet_name,
            marketName: market_name,
            marketType: market_type,
            betValue: normalizedBetValue,
            betRate: normalizedBetRate,
            winAmount: normalizedWinAmount,
            lossAmount: normalizedLossAmount,
            gtype: betGtype,
            settlementId: settlement_id,
            toReturn: to_return,
            status: BetStatus.PENDING,
            marketId,
            ...(eventId && { eventId }),
            metadata: runner_name_2 ? { runner_name_2 } : undefined,
          };

          if (selid) {
            betData.selId = selid;
          }

          const createdBet = await tx.bet.create({ data: betData });

          // 🔐 STEP 9: Update wallet (ATOMIC with bet creation)
          await tx.wallet.update({
            where: { userId },
            data: {
              balance: newBalance,
              liability: newLiability,
            },
          });

          // 🔐 STEP 10: Create transaction log
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              amount: Math.abs(exposureDelta),
              type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
              description: `${actualMarketType.charAt(0).toUpperCase() + actualMarketType.slice(1)} bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Delta: ${exposureDelta}`,
            },
          });

          this.logger.log(
            `Bet placed successfully: ${createdBet.id} for user ${userId}. ` +
            `Old Exposure: MO=${oldExposure.matchOdds}, Fancy=${oldExposure.fancy}, BM=${oldExposure.bookmaker} (Net: ${oldNetExposure}). ` +
            `New Exposure: MO=${newExposure.matchOdds}, Fancy=${newExposure.fancy}, BM=${newExposure.bookmaker} (Net: ${newNetExposure}). ` +
            `Delta: ${exposureDelta}`,
          );

          // Return bet info - position calculation happens AFTER transaction commits
          return {
            success: true,
            betId: createdBet.id,
            debug,
            available_balance: newBalance,
            marketType: actualMarketType,
            marketId,
          };
        },
        {
          maxWait: 15000,
          timeout: 30000,
        },
      );

      // ✅ POSITION CALCULATION (PURE, READ-ONLY, AFTER TRANSACTION)
      // Position is calculated fresh from all open bets - NOT stored in DB
      // Position calculation is isolated and never touches wallet/DB
      let positions: Record<string, { win: number; lose: number }> = {};
      
      try {
        // Fetch all pending bets for this user and market (after transaction commits)
        const pendingBets = await this.prisma.bet.findMany({
          where: {
            userId,
            marketId,
            status: BetStatus.PENDING,
          },
          select: {
            selectionId: true,
            betType: true,
            betRate: true,
            odds: true,
            betValue: true,
            amount: true,
            gtype: true,
            status: true,
            winAmount: true,
            lossAmount: true,
            marketId: true,
          },
        });

        this.logger.debug(
          `Position calculation: Found ${pendingBets.length} pending bets for user ${userId}, market ${marketId}`,
        );

        // ✅ MARKET ISOLATION: Use market-specific position functions
        if (transactionResult.marketType === 'matchodds' || transactionResult.marketType === 'match') {
          // Calculate Match Odds position (isolated)
          const matchOddsPosition = calculateMatchOddsPosition(pendingBets as Bet[], marketId);
          if (matchOddsPosition) {
            // Convert to backward-compatible format
            for (const [selectionId, position] of Object.entries(matchOddsPosition.positions)) {
              positions[selectionId] = {
                win: position.profit,
                lose: position.loss,
              };
            }
            this.logger.debug(
              `Match Odds position calculated: ${JSON.stringify(positions)}`,
            );
          }
        } else if (transactionResult.marketType === 'bookmaker') {
          // Calculate Bookmaker position (isolated)
          const bookmakerPosition = calculateBookmakerPosition(pendingBets as Bet[], marketId);
          if (bookmakerPosition) {
            // Convert to backward-compatible format
            // Bookmaker position now returns { profit, loss } per selection
            for (const [selectionId, position] of Object.entries(bookmakerPosition.positions)) {
              positions[selectionId] = {
                win: position.profit,
                lose: position.loss,
              };
            }
            this.logger.debug(
              `Bookmaker position calculated: ${JSON.stringify(positions)}`,
            );
          }
        } else if (transactionResult.marketType === 'fancy') {
          // Calculate Fancy position (isolated)
          const fancyPositions = calculateFancyPosition(pendingBets as Bet[]);
          // Fancy positions are grouped by fancyId, not selectionId
          // For backward compatibility, we return empty or could return first fancy position
          // Note: Fancy positions should typically be fetched via separate endpoint
          this.logger.debug(
            `Fancy position calculated for ${fancyPositions.length} fancy markets`,
          );
        } else {
          this.logger.debug(
            `Position calculation: Skipped for market type ${transactionResult.marketType}`,
          );
        }
      } catch (positionError) {
        // Log error but don't fail bet placement if position calculation fails
        // Position is UI-only and doesn't affect bet placement
        this.logger.warn(
          `Failed to calculate positions for user ${userId}, market ${marketId}:`,
          positionError instanceof Error ? positionError.message : String(positionError),
          positionError instanceof Error ? positionError.stack : undefined,
        );
      }

      // Return final result with positions
      return {
        success: true,
        betId: transactionResult.betId,
        positions,
        debug: transactionResult.debug,
        available_balance: transactionResult.available_balance,
      };
    } catch (error) {
      this.logger.error(`Error placing bet for user ${userId}:`, error);
      
      // If it's already an HttpException, re-throw it
      if (error instanceof HttpException) {
        throw error;
      }

      // Handle transaction errors specifically
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTransactionError = 
        errorMessage.includes('Transaction not found') ||
        errorMessage.includes('Transaction') ||
        errorMessage.includes('P2034') || // Prisma transaction timeout error code
        errorMessage.includes('P2035');   // Prisma transaction error code

      if (isTransactionError) {
        this.logger.error(
          `Transaction error placing bet for user ${userId}. This may be due to connection timeout or pool exhaustion.`,
          error instanceof Error ? error.stack : undefined,
        );
        throw new HttpException(
          {
            success: false,
            error: 'Transaction failed. Please try again. If the issue persists, the database connection may be experiencing issues.',
            code: 'TRANSACTION_ERROR',
            debug: {
              ...debug,
              error_details: errorMessage,
              suggestion: 'Retry the bet placement. If it continues to fail, check database connection health.',
            },
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Handle insufficient funds error (thrown from transaction)
      if (errorMessage.includes('Insufficient available balance')) {
        // Extract shortfall from error message if available
        const shortfallMatch = errorMessage.match(/Shortfall: ([\d.]+)/);
        const shortfall = shortfallMatch ? parseFloat(shortfallMatch[1]) : null;
        
        throw new HttpException(
          {
            success: false,
            error: `Insufficient available balance to lock liability. ${shortfall ? `Shortfall: ${shortfall}` : ''}`,
            code: 'INSUFFICIENT_FUNDS',
            debug: {
              ...debug,
              error_details: errorMessage,
              ...(shortfall && { shortfall }),
            },
          },
          400,
        );
      }

      // For other errors, wrap in a proper error response
      throw new HttpException(
        {
          success: false,
          error: errorMessage,
          code: 'BET_PLACEMENT_FAILED',
          debug: {
            ...debug,
            error_details: error instanceof Error ? error.stack : String(error),
          },
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
 

  /**
   * Validate exposure before placing a bet
   * Checks if user has sufficient balance to cover the bet liability
   * 
   * @param userId - User ID
   * @param bet - Bet object to validate
   * @throws HttpException if validation fails
   */
  private async validateExposure(userId: string, bet: Partial<Bet>): Promise<void> {
    // Get wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new HttpException(
        {
          success: false,
          error: `Wallet not found for user ${userId}`,
          code: 'WALLET_NOT_FOUND',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const currentBalance = Number(wallet.balance) || 0;
    const availableBalance = currentBalance;

    // Calculate bet liability
    const stake = bet.betValue ?? bet.amount ?? 0;
    const odds = bet.betRate ?? bet.odds ?? 0;
    const betLiability = this.calculateLiability(bet.gtype, bet.betType, stake, odds);

    // Check if user has sufficient balance
    if (availableBalance < betLiability) {
      throw new HttpException(
        {
          success: false,
          error: `Insufficient available balance. Balance: ${availableBalance}, Required: ${betLiability}`,
          code: 'INSUFFICIENT_FUNDS',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Place a bet and calculate positions for the market
   * 
   * This is a separate function from the main placeBet() method.
   * It takes a Bet object directly and calculates positions after placement.
   * 
   * @param bet - Bet object to place (must have all required fields including userId, matchId, marketId)
   * @param userId - User ID
   * @param selections - Array of selection IDs (as strings) for position calculation
   * @returns Calculated positions for the market (win/lose scenarios per selection)
   */
  async placeBetAndCalculatePositions(
    bet: Partial<Bet> & { userId: string; matchId: string; marketId: string },
    userId: string,
    selections: string[],
  ): Promise<Record<string, { win: number; lose: number }>> {
    // 1️⃣ Validate balance & exposure
    await this.validateExposure(userId, bet);

    // 2️⃣ Save bet
    const betData: any = {
      userId: bet.userId,
      matchId: bet.matchId,
      marketId: bet.marketId,
      amount: bet.amount ?? 0,
      odds: bet.odds ?? 0,
      status: bet.status ?? BetStatus.PENDING,
      ...(bet.selectionId !== undefined && { selectionId: bet.selectionId }),
      ...(bet.selId !== undefined && { selId: bet.selId }),
      ...(bet.betType && { betType: bet.betType }),
      ...(bet.betName && { betName: bet.betName }),
      ...(bet.marketName && { marketName: bet.marketName }),
      ...(bet.marketType && { marketType: bet.marketType }),
      ...(bet.gtype && { gtype: bet.gtype }),
      ...(bet.betValue !== undefined && { betValue: bet.betValue }),
      ...(bet.betRate !== undefined && { betRate: bet.betRate }),
      ...(bet.winAmount !== undefined && { winAmount: bet.winAmount }),
      ...(bet.lossAmount !== undefined && { lossAmount: bet.lossAmount }),
      ...(bet.settlementId && { settlementId: bet.settlementId }),
      ...(bet.toReturn !== undefined && { toReturn: bet.toReturn }),
      ...(bet.eventId && { eventId: bet.eventId }),
      ...(bet.metadata && { metadata: bet.metadata }),
    };

    const createdBet = await this.prisma.bet.create({
      data: betData,
    });

    // 3️⃣ Fetch all pending bets of market
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        userId,
        marketId: bet.marketId,
        status: BetStatus.PENDING,
      },
    });

    // 4️⃣ Recalculate authoritative positions using market-specific functions
    // Determine market type from bets
    const betGtype = (bet.gtype || '').toLowerCase();
    let authoritativePositions: Record<string, { win: number; lose: number }> = {};

    if (betGtype === 'matchodds' || betGtype === 'match') {
      // Match Odds position
      const matchOddsPosition = calculateMatchOddsPosition(pendingBets, bet.marketId);
      if (matchOddsPosition) {
        for (const [selectionId, position] of Object.entries(matchOddsPosition.positions)) {
          authoritativePositions[selectionId] = {
            win: position.profit,
            lose: position.loss,
          };
        }
      }
    } else if (betGtype === 'bookmaker' || 
               (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds')) {
      // Bookmaker position
      const bookmakerPosition = calculateBookmakerPosition(pendingBets, bet.marketId);
      if (bookmakerPosition) {
        // Bookmaker position now returns { profit, loss } per selection
        for (const [selectionId, position] of Object.entries(bookmakerPosition.positions)) {
          authoritativePositions[selectionId] = {
            win: position.profit,
            lose: position.loss,
          };
        }
      }
    } else {
      // Fallback to old function for backward compatibility (e.g., fancy or unknown)
      authoritativePositions = calculatePositions(selections, pendingBets);
    }

    return authoritativePositions;
  }

  /**
   * Get position details for a user's bets in a specific market
   * 
   * ✅ Uses market-specific position functions for proper isolation
   * 
   * @param userId - User ID
   * @param marketId - Market ID
   * @param marketSelections - Array of selection IDs (as strings) for position calculation (backward compatibility)
   * @returns Calculated positions for each selection (win/lose scenarios)
   */
  async getMarketPositions(
    userId: string,
    marketId: string,
    marketSelections: string[],
  ): Promise<Record<string, { win: number; lose: number }>> {
    // Fetch all pending bets for the market
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        userId,
        marketId,
        status: BetStatus.PENDING,
      },
    });

    if (pendingBets.length === 0) {
      return {};
    }

    // Determine market type from first bet (all bets in market should have same gtype)
    const firstBetGtype = (pendingBets[0]?.gtype || '').toLowerCase();
    let authoritativePositions: Record<string, { win: number; lose: number }> = {};

    if (firstBetGtype === 'matchodds' || firstBetGtype === 'match') {
      // Match Odds position (isolated)
      const matchOddsPosition = calculateMatchOddsPosition(pendingBets, marketId);
      if (matchOddsPosition) {
        for (const [selectionId, position] of Object.entries(matchOddsPosition.positions)) {
          authoritativePositions[selectionId] = {
            win: position.profit,
            lose: position.loss,
          };
        }
      }
    } else if (firstBetGtype === 'bookmaker' || 
               (firstBetGtype.startsWith('match') && firstBetGtype !== 'match' && firstBetGtype !== 'matchodds')) {
      // Bookmaker position (isolated)
      const bookmakerPosition = calculateBookmakerPosition(pendingBets, marketId);
      if (bookmakerPosition) {
        // Bookmaker position now returns { profit, loss } per selection
        for (const [selectionId, position] of Object.entries(bookmakerPosition.positions)) {
          authoritativePositions[selectionId] = {
            win: position.profit,
            lose: position.loss,
          };
        }
      }
    } else if (firstBetGtype === 'fancy') {
      // Fancy position (isolated) - returns empty for backward compatibility
      // Fancy positions should be fetched via separate endpoint that returns proper structure
      this.logger.debug(`Fancy positions not returned in getMarketPositions - use dedicated fancy endpoint`);
    } else {
      // Fallback to old function for unknown market types (backward compatibility)
      authoritativePositions = calculatePositions(marketSelections, pendingBets);
    }

    return authoritativePositions;
  }
}


