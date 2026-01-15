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

  /**
   * ✅ MATCH ODDS EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates exposure for Match Odds market ONLY
   * ✅ FIXED: Properly nets BACK and LAY bets on the same selection
   * Grouped by selectionId first to enable netting, then summed for market
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @param marketId - Market ID
   * @returns Net exposure for this Match Odds market
   */
  // private async calculateMatchOddsExposure(
  //   tx: any,
  //   userId: string,
  //   marketId: string,
  // ): Promise<number> {
  //   try {
  //     const bets = await tx.bet.findMany({
  //       where: {
  //         userId,
  //         marketId,
  //         status: BetStatus.PENDING,
  //         gtype: { in: ['matchodds', 'match'] },
  //       },
  //       select: {
  //         betType: true,
  //         winAmount: true,
  //         lossAmount: true,
  //         betValue: true,
  //         amount: true,
  //         betRate: true,
  //         odds: true,
  //         selectionId: true,
  //       },
  //     });
    
  //     // Group by selection (runner) to properly net BACK and LAY bets on same selection
  //     const selectionMap = new Map<
  //       number,
  //       {
  //         totalBackStake: number;
  //         totalBackWinAmount: number;
  //         totalLayLiability: number;
  //         totalLayStake: number;
  //       }
  //     >();

  //     // Aggregate all bets per selection to enable proper netting
  //     for (const bet of bets) {
  //       if (!bet.selectionId) continue;
        
  //       if (!selectionMap.has(bet.selectionId)) {
  //         selectionMap.set(bet.selectionId, {
  //           totalBackStake: 0,
  //           totalBackWinAmount: 0,
  //           totalLayLiability: 0,
  //           totalLayStake: 0,
  //         });
  //       }

  //       const position = selectionMap.get(bet.selectionId)!;
  //       const stake = bet.betValue || bet.amount || 0;
  //       const odds = bet.betRate || bet.odds || 0;

  //       if (bet.betType === 'BACK') {
  //         // BACK bet: liability = stake, winAmount = stake * odds
  //         position.totalBackStake += stake;
  //         position.totalBackWinAmount += bet.winAmount || stake * odds || 0;
  //       } else if (bet.betType === 'LAY') {
  //         // LAY bet: liability = (odds - 1) * stake, stake kept if wins
  //         const layLiability = (odds - 1) * stake;
  //         position.totalLayLiability += layLiability;
  //         position.totalLayStake += stake;
  //       }
  //     }
    
  //     // Calculate net exposure per selection, then sum for market
  //     let marketExposure = 0;

  //     for (const [selectionId, position] of selectionMap) {
  //       // Net the BACK and LAY positions on this selection
  //       // If BACK 100 @ 2.0 and LAY 100 @ 2.0 on same selection:
  //       // - Net stake: 100 - 100 = 0 → Exposure = 0 (properly offset)
        
  //       const netStake = position.totalBackStake - position.totalLayStake;

  //       // Calculate exposure based on net position
  //       if (netStake > 0) {
  //         // Net BACK position: exposure = net stake (BACK liability = stake)
  //         marketExposure += netStake;
  //       } else if (netStake < 0) {
  //         // Net LAY position: calculate average odds for remaining LAY bets
  //         // exposure = (avg odds - 1) * |net stake|
  //         const avgOdds = position.totalLayStake > 0
  //           ? (position.totalLayLiability / position.totalLayStake) + 1
  //           : 1;
  //         const netLayLiability = (avgOdds - 1) * Math.abs(netStake);
  //         marketExposure += netLayLiability;
  //       }
  //       // If netStake === 0, exposure = 0 (fully offset)
  //     }
    
  //     return marketExposure;
  //   } catch (error: any) {
  //     // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
  //     if (error?.message?.includes('Transaction not found') || 
  //         error?.message?.includes('Transaction ID is invalid') ||
  //         error?.message?.includes('Transaction already closed')) {
  //       this.logger.warn(
  //         `Transaction invalid in calculateMatchOddsExposure for userId: ${userId}, marketId: ${marketId}. Returning 0 exposure.`,
  //       );
  //       return 0;
  //     }
  //     // Re-throw other errors
  //     throw error;
  //   }
  // }
  

  /**
   * ✅ FANCY EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates exposure for Fancy market ONLY
   * ✅ EXCHANGE RULE: Different lines do NOT hedge, only same-line reverse can reduce exposure
   * - Group bets by eventId_selectionId_rate (same-line grouping)
   * - Same-line: YES @ X + NO @ X = full liability (sum, not offset)
   * - Different lines: YES @ A + NO @ B = full liability (sum, NO hedge)
   * - Exposure is SUM of ALL fancy stakes (no cross-line hedging)
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @param eventId - Event ID
   * @param selectionId - Selection ID
   * @returns Net exposure for this Fancy selection
   */
  // private async calculateFancyExposure(
  //   tx: any,
  //   userId: string,
  //   eventId: string,
  //   selectionId: number,
  // ): Promise<number> {
  //   try {
  //     const bets = await tx.bet.findMany({
  //       where: {
  //         userId,
  //         status: BetStatus.PENDING,
  //         gtype: 'fancy',
  //         eventId,
  //         selectionId,
  //       },
  //       select: {
  //         betType: true,
  //         betValue: true,
  //         amount: true,
  //         betRate: true,
  //         odds: true,
  //       },
  //     });

  //     // Group bets by eventId_selectionId_rate (same-line grouping)
  //     // Note: eventId and selectionId are fixed in this function (from parameters)
  //     const grouped = new Map<number, {
  //       yes: number;
  //       no: number;
  //     }>();

  //     for (const bet of bets) {
  //       const stake = bet.betValue ?? bet.amount ?? 0;
  //       const betTypeUpper = (bet.betType || '').toUpperCase();
  //       const rate = bet.betRate ?? bet.odds ?? 0;
  //       // Group by rate (eventId and selectionId are already filtered in query)

  //       if (!grouped.has(rate)) {
  //         grouped.set(rate, { yes: 0, no: 0 });
  //       }

  //       const bucket = grouped.get(rate)!;

  //       // FANCY: liability = stake (for both BACK and LAY)
  //       // YES/NO are treated the same as BACK/LAY
  //       if (betTypeUpper === 'YES' || betTypeUpper === 'BACK') {
  //         bucket.yes += stake;
  //       } else if (betTypeUpper === 'NO' || betTypeUpper === 'LAY') {
  //         bucket.no += stake;
  //       }
  //     }

  //     // Calculate exposure: SUM of ALL stakes (no cross-line hedging)
  //     let exposure = 0;

  //     for (const [, g] of grouped) {
  //       // Same-line YES & NO → sum (no hedge)
  //       // Different lines also sum (no hedge)
  //       exposure += g.yes + g.no;
  //     }

  //     return exposure;
  //   } catch (error: any) {
  //     // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
  //     if (error?.message?.includes('Transaction not found') || 
  //         error?.message?.includes('Transaction ID is invalid') ||
  //         error?.message?.includes('Transaction already closed')) {
  //       this.logger.warn(
  //         `Transaction invalid in calculateFancyExposure for userId: ${userId}, eventId: ${eventId}, selectionId: ${selectionId}. Returning 0 exposure.`,
  //       );
  //       return 0;
  //     }
  //     // Re-throw other errors
  //     throw error;
  //   }
  // }

  /**
   * ✅ BOOKMAKER EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates exposure for Bookmaker market ONLY
   * SAME as Match Odds: BACK = stake, LAY = (odds - 1) × stake
   * Exposure formula: abs(totalBackStake - totalLayLiability)
   * Grouped by marketId (NOT selectionId)
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @param marketId - Market ID
   * @returns Net exposure for this Bookmaker market
   */
  // private async calculateBookmakerExposure(
  //   tx: any,
  //   userId: string,
  //   marketId: string,
  // ): Promise<number> {
  //   try {
  //     // Query for bookmaker bets: includes 'bookmaker' and numbered match variants (match1, match2, etc.)
  //     // First, find all bets for this marketId to check gtype patterns
  //     const allBets = await tx.bet.findMany({
  //       where: {
  //         userId,
  //         status: BetStatus.PENDING,
  //         marketId,
  //       },
  //       select: {
  //         gtype: true,
  //         betType: true,
  //         betValue: true,
  //         amount: true,
  //         betRate: true,
  //         odds: true,
  //       },
  //     });

  //     // Filter for bookmaker bets: 'bookmaker' or numbered match variants (match1, match2, etc.)
  //     const bets = allBets.filter((bet: any) => {
  //       const betGtype = (bet.gtype || '').toLowerCase();
  //       return betGtype === 'bookmaker' || 
  //              (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
  //     });

  //     let totalBackStake = 0;
  //     let totalLayLiability = 0;

  //     for (const bet of bets) {
  //       const stake = bet.betValue ?? bet.amount ?? 0;
  //       const odds = bet.betRate ?? bet.odds ?? 0;
  //       const betTypeUpper = (bet.betType || '').toUpperCase();

  //       if (betTypeUpper === 'BACK') {
  //         // BOOKMAKER BACK: liability = stake
  //         totalBackStake += stake;
  //       } else if (betTypeUpper === 'LAY') {
  //         // BOOKMAKER LAY: liability = (odds - 1) × stake
  //         totalLayLiability += (odds - 1) * stake;
  //       }
  //     }

  //     // Exposure = abs(totalBackStake - totalLayLiability)
  //     return Math.abs(totalBackStake - totalLayLiability);
  //   } catch (error: any) {
  //     // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
  //     if (error?.message?.includes('Transaction not found') || 
  //         error?.message?.includes('Transaction ID is invalid') ||
  //         error?.message?.includes('Transaction already closed')) {
  //       this.logger.warn(
  //         `Transaction invalid in calculateBookmakerExposure for userId: ${userId}, marketId: ${marketId}. Returning 0 exposure.`,
  //       );
  //       return 0;
  //     }
  //     // Re-throw other errors
  //     throw error;
  //   }
  // }

  /**
   * ✅ EXPOSURE BY MARKET TYPE (PURE IN-MEMORY)
   * 
   * Calculates exposure broken down by market type.
   * This is a PURE FUNCTION - no DB access, no side effects.
   * 
   * @param bets - Array of ALL pending bets for the user
   * @returns Exposure object with matchOdds, fancy, and bookmaker exposure
   */
  private calculateExposureByMarketType(bets: any[]): {
    matchOdds: number;
    fancy: number;
    bookmaker: number;
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

    return {
      matchOdds: matchOddsExposure,
      fancy: fancyExposure,
      bookmaker: bookmakerExposure,
    };
  }

  /**
   * ✅ TOTAL EXPOSURE ACROSS ALL MARKETS (SUM OF MARKET-SPECIFIC EXPOSURES)
   * 
   * Calculates total exposure by summing market-specific exposures
   * Each market type uses its own exposure calculation logic
   * 
   * 🔐 CRITICAL INVARIANT:
   * wallet.liability === calculateTotalExposure(userId)
   * 
   * This function is the SINGLE SOURCE OF TRUTH for total exposure.
   * All wallet updates MUST use exposureDelta = totalExposureAfter - totalExposureBefore
   * to maintain this invariant across all market types.
   * 
   * 🚀 OPTIMIZED: Fetches all bets in a single query to avoid transaction timeouts
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @returns Total net exposure across all markets
   */
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

  /**
   * Calculate Match Odds exposure in memory (no database queries)
   * ✅ EXCHANGE-ACCURATE: Order-independent exposure calculation with symmetric BACK↔LAY hedging
   * 
   * Algorithm:
   * 1. Aggregate net position per selection (winProfit, loseLoss)
   * 2. For each possible winner, calculate total P/L
   * 3. Exposure = maximum absolute negative P/L across all outcomes
   * 
   * Exchange Rules:
   * - BACK bet on winner: profit = (odds - 1) × stake
   * - BACK bet on loser: loss = stake
   * - LAY bet on winner: loss = stake × odds (full payout)
   * - LAY bet on loser: profit = stake (keep stake received)
   * 
   * @param bets - Array of bets for the market
   * @returns Net exposure for this Match Odds market
   */
  private calculateMatchOddsExposureInMemory(bets: any[]): number {
    if (!bets.length) return 0;
  
    const positionBySelection = new Map<number, { win: number; lose: number }>();
  
    for (const bet of bets) {
      if (!bet.selectionId) continue;
  
        const stake = Number(bet.betValue || bet.amount || 0);
        const odds = Number(bet.betRate || bet.odds || 0);
      const type = (bet.betType || '').toUpperCase();
  
      if (!positionBySelection.has(bet.selectionId)) {
        positionBySelection.set(bet.selectionId, { win: 0, lose: 0 });
      }
  
      const pos = positionBySelection.get(bet.selectionId)!;
  
      if (type === 'BACK') {
        pos.win += (odds - 1) * stake;
        pos.lose -= stake;
        }
  
      if (type === 'LAY') {
        pos.win -= (odds - 1) * stake;
        pos.lose += stake;
          }
        }
  
    let exposure = 0;
  
    for (const [winner] of positionBySelection) {
      let pnl = 0;
  
      for (const [sid, pos] of positionBySelection) {
        pnl += sid === winner ? pos.win : pos.lose;
    }
  
      if (pnl < 0) {
        exposure = Math.max(exposure, Math.abs(pnl));
      }
    }
  
    // 🔐 SAFETY PATCH: Apply BACK stake floor ONLY when net unhedged BACK exposure exists
    // If BACK and LAY hedge each other → exposure MUST reduce (can reach 0)
    // BACK stake floor applies ONLY when net position is unhedged
    let totalBackStake = 0;
    let totalLayStake = 0;
    
    for (const bet of bets) {
      const type = (bet.betType || '').toUpperCase();
      const stake = Number(bet.betValue || bet.amount || 0);
      
      if (type === 'BACK') {
        totalBackStake += stake;
      } else if (type === 'LAY') {
        totalLayStake += stake;
      }
    }
    
    // Apply BACK safety floor ONLY when net BACK exposure exists (not fully hedged)
    if (totalBackStake > totalLayStake) {
      // Net unhedged BACK stake = totalBackStake - totalLayStake
      // Exposure must be at least this net amount
      const netBackStake = totalBackStake - totalLayStake;
      exposure = Math.max(exposure, netBackStake);
    }
    // If totalLayStake >= totalBackStake (fully hedged or net LAY), allow exposure to be 0 or as calculated
  
    return exposure;
  }
  
  
  

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
   * ✅ GOLA FANCY SUPPORT:
   * - Multiple fancy lines belong to ONE gola group (identified by metadata.golaGroupId)
   * - Only ONE line can win, all other lines lose
   * - Exposure = worst-case loss across all possible outcomes
   * 
   * @param bets - Array of bets for the fancy selection
   * @returns Net exposure for this Fancy selection
   */
  private calculateFancyExposureInMemory(bets: any[]): number {
    // 1️⃣ Split bets into normal fancy and gola fancy
    const normalFancyBets: any[] = [];
    const golaFancyBets: any[] = [];

    for (const bet of bets) {
      const metadata = bet.metadata || {};
      const golaGroupId = metadata.golaGroupId;
      
      if (golaGroupId) {
        golaFancyBets.push(bet);
      } else {
        normalFancyBets.push(bet);
      }
    }

    // 2️⃣ NORMAL FANCY: Use existing same-line reverse logic (UNCHANGED)
    const normalExposure = this.calculateNormalFancyExposure(normalFancyBets);

    // 3️⃣ GOLA FANCY: Calculate worst-case exposure across all outcomes
    const golaExposure = this.calculateGolaFancyExposure(golaFancyBets);

    // 4️⃣ FINAL RESULT: Sum of normal fancy exposure + gola fancy exposure
    return normalExposure + golaExposure;
  }

  /**
   * Calculate normal fancy exposure
   * ✅ EXCHANGE-CORRECT: Worst-case loss across all outcomes
   * 
   * Rules:
   * - Group bets by (eventId + selectionId) = fancy market
   * - Same-line YES/NO → hedge: exposure = |YES - NO|
   * - Multiple different rates → worst-case: exposure = total YES stake + total NO stake
   * - No unlocking or risk-free assumptions at placement time
   * - Exposure must always represent worst-case loss
   */
  private calculateNormalFancyExposure(bets: any[]): number {
    if (bets.length === 0) {
      return 0;
    }

    // Group bets by eventId_selectionId (same fancy market)
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

    // Process each fancy market separately
    for (const [fancyKey, fancyBets] of betsByFancy) {
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
    }

    return totalExposure;
  }

  /**
   * Calculate gola fancy exposure (worst-case loss across all outcomes)
   * GOLA RULE: Only ONE line can win, all others lose
   * - Group bets by golaGroupId, then by line (eventId + selectionId + rate)
   * - For each possible outcome (one line wins):
   *   - Winning line: YES wins, NO loses
   *   - All other lines: Both YES and NO lose
   * - Exposure = MAX(net loss across all outcomes)
   */
  private calculateGolaFancyExposure(bets: any[]): number {
    if (bets.length === 0) {
      return 0;
    }

    // Group bets by golaGroupId
    const golaGroups = new Map<string, any[]>();

    for (const bet of bets) {
      const metadata = bet.metadata || {};
      const golaGroupId = metadata.golaGroupId;
      
      if (!golaGroupId) {
        continue; // Skip if no golaGroupId (shouldn't happen, but safety check)
      }

      if (!golaGroups.has(golaGroupId)) {
        golaGroups.set(golaGroupId, []);
      }

      golaGroups.get(golaGroupId)!.push(bet);
    }

    let totalGolaExposure = 0;

    // Process each gola group independently
    for (const [golaGroupId, groupBets] of golaGroups) {
      // Group bets by line (eventId + selectionId + rate)
      const linesByKey = new Map<string, {
        yes: number;
        no: number;
        eventId: string;
        selectionId: number;
        rate: number;
      }>();

      for (const bet of groupBets) {
        const stake = bet.betValue ?? bet.amount ?? 0;
        const betTypeUpper = (bet.betType || '').toUpperCase();
        const rate = bet.betRate ?? bet.odds ?? 0;
        const eventId = bet.eventId || '';
        const selectionId = bet.selectionId || 0;
        
        // Group by eventId_selectionId_rate (same line)
        const lineKey = `${eventId}_${selectionId}_${rate}`;

        if (!linesByKey.has(lineKey)) {
          linesByKey.set(lineKey, {
            yes: 0,
            no: 0,
            eventId,
            selectionId,
            rate,
          });
        }

        const line = linesByKey.get(lineKey)!;

        if (betTypeUpper === 'YES' || betTypeUpper === 'BACK') {
          line.yes += stake;
        } else if (betTypeUpper === 'NO' || betTypeUpper === 'LAY') {
          line.no += stake;
        }
      }

      // Enumerate all possible outcomes (one line wins at a time)
      const lines = Array.from(linesByKey.values());
      let maxLoss = 0;

      for (const winningLine of lines) {
        // Calculate net loss for this outcome
        let netLoss = 0;

        for (const line of lines) {
          if (line === winningLine) {
            // Winning line: YES wins, NO loses
            // Loss = NO stake (we pay out YES, but NO loses)
            netLoss += line.no;
          } else {
            // All other lines: Both YES and NO lose
            // Loss = YES stake + NO stake (we pay out both)
            netLoss += line.yes + line.no;
          }
        }

        // Track worst-case loss
        maxLoss = Math.max(maxLoss, netLoss);
      }

      // Gola exposure must NEVER be negative
      totalGolaExposure += Math.max(0, maxLoss);
    }

    return totalGolaExposure;
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

  // ---------------------------------- MARKET-SPECIFIC BET PLACEMENT (DEPRECATED) ---------------------------------- //
  // ⚠️ THESE FUNCTIONS ARE DEPRECATED - They are kept for reference but should NOT be used
  // All bet placement logic is now centralized in the master placeBet() function below

  /**
   * @deprecated Use placeBet() instead - All bet placement is now centralized
   */
  // private async placeMatchOddsBet(
  //   input: PlaceBetDto,
  //   normalizedBetValue: number,
  //   normalizedBetRate: number,
  //   normalizedSelectionId: number,
  //   normalizedWinAmount: number,
  //   normalizedLossAmount: number,
  //   userId: string,
  //   marketId: string,
  //   debug: Record<string, unknown>,
  // ) {
  //   const {
  //     bet_type,
  //     bet_name,
  //     match_id,
  //     market_name,
  //     market_type,
  //     eventId,
  //     runner_name_2,
  //     selection_id,
  //   } = input;

  //   const selid = Math.floor(Math.random() * 90000000) + 10000000;
  //   const settlement_id = `${match_id}_${selection_id}`;
  //   const to_return = normalizedWinAmount + normalizedLossAmount;

  //   return await this.prisma.$transaction(
  //     async (tx) => {
  //       // Step 1: Ensure match exists
  //       await tx.match.upsert({
  //         where: { id: String(match_id) },
  //         update: {
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //         create: {
  //           id: String(match_id),
  //           homeTeam: bet_name ?? 'Unknown',
  //           awayTeam: market_name ?? 'Unknown',
  //           startTime: new Date(),
  //           status: MatchStatus.LIVE,
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //       });

  //       // Step 2: Get current wallet state
  //       const currentWallet = await tx.wallet.upsert({
  //         where: { userId },
  //         update: {},
  //         create: {
  //           userId,
  //           balance: 0,
  //           liability: 0,
  //         },
  //       });

  //       const currentBalance = Number(currentWallet.balance) || 0;
  //       const currentLiability = Number(currentWallet.liability) || 0;

  //       // Step 3: Calculate total exposure BEFORE bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
  //       // This ensures wallet.liability always matches calculated total exposure across all markets
  //       // Prevents liability jumps when switching between Match Odds, Fancy, and Bookmaker markets
  //       const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

  //       // Step 4: Create the bet FIRST
  //       const betData: any = {
  //         userId,
  //         matchId: String(match_id),
  //         amount: normalizedBetValue,
  //         odds: normalizedBetRate,
  //         selectionId: normalizedSelectionId,
  //         betType: bet_type,
  //         betName: bet_name,
  //         marketName: market_name,
  //         marketType: market_type,
  //         betValue: normalizedBetValue,
  //         betRate: normalizedBetRate,
  //         winAmount: normalizedWinAmount,
  //         lossAmount: normalizedLossAmount,
  //         gtype: 'matchodds',
  //         settlementId: settlement_id,
  //         toReturn: to_return,
  //         status: BetStatus.PENDING,
  //         marketId,
  //         ...(eventId && { eventId }),
  //         metadata: runner_name_2 ? { runner_name_2 } : undefined,
  //       };

  //       if (selid) {
  //         betData.selId = selid;
  //       }

  //       const bet = await tx.bet.create({ data: betData });

  //       // Step 5: Calculate total exposure AFTER bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (preserves Fancy, Bookmaker, other Match Odds liability)
  //       const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
  //       const exposureDelta = totalExposureAfter - totalExposureBefore;

  //       // Step 6: Validate balance before updating wallet
  //       if (exposureDelta > 0 && currentBalance < exposureDelta) {
  //         throw new Error(
  //           `Insufficient available balance. ` +
  //           `Balance: ${currentBalance}, Required: ${exposureDelta}`,
  //         );
  //       }

  //       // Step 7: Update wallet using exposure delta (CRITICAL INVARIANT)
  //       // 🔐 TOTAL EXPOSURE DELTA MODEL:
  //       // balance -= exposureDelta (if exposure increases) or += |exposureDelta| (if decreases)
  //       // liability += exposureDelta (can be positive or negative)
  //       // Wallet invariant: wallet.liability === calculateTotalExposure(userId)
  //       // This ensures liability always matches calculated total exposure across all markets
        
  //       await tx.wallet.update({
  //         where: { userId },
  //         data: {
  //           balance:
  //             exposureDelta > 0
  //               ? currentBalance - exposureDelta
  //               : currentBalance + Math.abs(exposureDelta),
  //           liability: currentLiability + exposureDelta,
  //         },
  //       });

  //       // Step 8: Create transaction log using exposureDelta
  //       await tx.transaction.create({
  //         data: {
  //           walletId: currentWallet.id,
  //           amount: Math.abs(exposureDelta),
  //           type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
  //           description: `Match Odds bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
  //         },
  //       });

  //       debug.matchodds_exposure_delta = exposureDelta;
  //       debug.matchodds_total_exposure_before = totalExposureBefore;
  //       debug.matchodds_total_exposure_after = totalExposureAfter;
  //       debug.matchodds_old_balance = currentBalance;
  //       debug.matchodds_new_balance = exposureDelta > 0
  //         ? currentBalance - exposureDelta
  //         : currentBalance + Math.abs(exposureDelta);
  //       debug.matchodds_old_liability = currentLiability;
  //       debug.matchodds_new_liability = currentLiability + exposureDelta;

  //       return { betId: bet.id };
  //     },
  //     {
  //       maxWait: 10000,
  //       timeout: 20000,
  //     },
  //   );
  // }

  /**
   * @deprecated Use placeBet() instead - All bet placement is now centralized
   */
  // private async placeFancyBet(
  //   input: PlaceBetDto,
  //   normalizedBetValue: number,
  //   normalizedBetRate: number,
  //   normalizedSelectionId: number,
  //   normalizedWinAmount: number,
  //   normalizedLossAmount: number,
  //   userId: string,
  //   marketId: string,
  //   debug: Record<string, unknown>,
  // ) {
  //   const {
  //     bet_type,
  //     bet_name,
  //     match_id,
  //     market_name,
  //     market_type,
  //     eventId,
  //     runner_name_2,
  //     selection_id,
  //   } = input;

  //   const selid = Math.floor(Math.random() * 90000000) + 10000000;
  //   const settlement_id = `${match_id}_${selection_id}`;
  //   const to_return = normalizedWinAmount + normalizedLossAmount;

  //   return await this.prisma.$transaction(
  //     async (tx) => {
  //       // Step 1: Ensure match exists
  //       await tx.match.upsert({
  //         where: { id: String(match_id) },
  //         update: {
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //         create: {
  //           id: String(match_id),
  //           homeTeam: bet_name ?? 'Unknown',
  //           awayTeam: market_name ?? 'Unknown',
  //           startTime: new Date(),
  //           status: MatchStatus.LIVE,
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //       });

  //       // Step 2: Get current wallet state
  //       const currentWallet = await tx.wallet.upsert({
  //         where: { userId },
  //         update: {},
  //         create: {
  //           userId,
  //           balance: 0,
  //           liability: 0,
  //         },
  //       });

  //       const currentBalance = Number(currentWallet.balance) || 0;
  //       const currentLiability = Number(currentWallet.liability) || 0;

  //       // Step 3: Calculate total exposure BEFORE bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
  //       // This ensures wallet.liability always matches calculated total exposure across all markets
  //       // Prevents liability jumps when switching between Match Odds, Fancy, and Bookmaker markets
  //       // Fancy exposure is calculated per (eventId, selectionId) and includes netting
  //       const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

  //       // Step 4: Create the bet FIRST
  //       const betData: any = {
  //         userId,
  //         matchId: String(match_id),
  //         amount: normalizedBetValue,
  //         odds: normalizedBetRate,
  //         selectionId: normalizedSelectionId,
  //         betType: bet_type,
  //         betName: bet_name,
  //         marketName: market_name,
  //         marketType: market_type,
  //         betValue: normalizedBetValue,
  //         betRate: normalizedBetRate,
  //         winAmount: normalizedWinAmount,
  //         lossAmount: normalizedLossAmount,
  //         gtype: 'fancy',
  //         settlementId: settlement_id,
  //         toReturn: to_return,
  //         status: BetStatus.PENDING,
  //         marketId,
  //         ...(eventId && { eventId }),
  //         metadata: runner_name_2 ? { runner_name_2 } : undefined,
  //       };

  //       if (selid) {
  //         betData.selId = selid;
  //       }

  //       const bet = await tx.bet.create({ data: betData });

  //       // Step 5: Calculate total exposure AFTER bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (preserves Match Odds, Bookmaker, other Fancy liability)
  //       // Fancy exposure calculation includes netting: BACK 100 + LAY 100 = 0 net exposure
  //       const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
  //       const exposureDelta = totalExposureAfter - totalExposureBefore;

  //       // Step 6: Validate balance before updating wallet
  //       if (exposureDelta > 0 && currentBalance < exposureDelta) {
  //         throw new Error(
  //           `Insufficient available balance. ` +
  //           `Balance: ${currentBalance}, Required: ${exposureDelta}`,
  //         );
  //       }

  //       // Step 7: Update wallet using exposure delta (CRITICAL INVARIANT)
  //       // 🔐 TOTAL EXPOSURE DELTA MODEL:
  //       // balance -= exposureDelta (if exposure increases) or += |exposureDelta| (if decreases)
  //       // liability += exposureDelta (can be positive or negative due to netting)
  //       // Wallet invariant: wallet.liability === calculateTotalExposure(userId)
  //       // This ensures liability always matches calculated total exposure across all markets
  //       // Fancy bets can have negative exposureDelta when netting reduces total exposure
        
  //       await tx.wallet.update({
  //         where: { userId },
  //         data: {
  //           balance:
  //             exposureDelta > 0
  //               ? currentBalance - exposureDelta
  //               : currentBalance + Math.abs(exposureDelta),
  //           liability: currentLiability + exposureDelta,
  //         },
  //       });

  //       // Step 8: Create transaction log using exposureDelta
  //       await tx.transaction.create({
  //         data: {
  //           walletId: currentWallet.id,
  //           amount: Math.abs(exposureDelta),
  //           type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
  //           description: `Fancy bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
  //         },
  //       });

  //       debug.fancy_exposure_delta = exposureDelta;
  //       debug.fancy_total_exposure_before = totalExposureBefore;
  //       debug.fancy_total_exposure_after = totalExposureAfter;
  //       debug.fancy_old_balance = currentBalance;
  //       debug.fancy_new_balance = exposureDelta > 0
  //         ? currentBalance - exposureDelta
  //         : currentBalance + Math.abs(exposureDelta);
  //       debug.fancy_old_liability = currentLiability;
  //       debug.fancy_new_liability = currentLiability + exposureDelta;

  //       return { betId: bet.id };
  //     },
  //     {
  //       maxWait: 15000, // Increased from 10000 to handle complex exposure calculations
  //       timeout: 30000, // Increased from 20000 to prevent transaction timeouts
  //     },
  //   );
  // }

  /**
   * @deprecated Use placeBet() instead - All bet placement is now centralized
   */
  // private async placeBookmakerBet(
  //   input: PlaceBetDto,
  //   normalizedBetValue: number,
  //   normalizedBetRate: number,
  //   normalizedSelectionId: number,
  //   normalizedWinAmount: number,
  //   normalizedLossAmount: number,
  //   userId: string,
  //   marketId: string,
  //   debug: Record<string, unknown>,
  // ) {
  //   const {
  //     bet_type,
  //     bet_name,
  //     match_id,
  //     market_name,
  //     market_type,
  //     eventId,
  //     runner_name_2,
  //     selection_id,
  //   } = input;

  //   const selid = Math.floor(Math.random() * 90000000) + 10000000;
  //   const settlement_id = `${match_id}_${selection_id}`;
  //   const to_return = normalizedWinAmount + normalizedLossAmount;

  //   return await this.prisma.$transaction(
  //     async (tx) => {
  //       // Step 1: Ensure match exists
  //       await tx.match.upsert({
  //         where: { id: String(match_id) },
  //         update: {
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //         create: {
  //           id: String(match_id),
  //           homeTeam: bet_name ?? 'Unknown',
  //           awayTeam: market_name ?? 'Unknown',
  //           startTime: new Date(),
  //           status: MatchStatus.LIVE,
  //           ...(eventId && { eventId }),
  //           ...(marketId && { marketId }),
  //         },
  //       });

  //       // Step 2: Get current wallet state
  //       const currentWallet = await tx.wallet.upsert({
  //         where: { userId },
  //         update: {},
  //         create: {
  //           userId,
  //           balance: 0,
  //           liability: 0,
  //         },
  //       });

  //       const currentBalance = Number(currentWallet.balance) || 0;
  //       const currentLiability = Number(currentWallet.liability) || 0;

  //       // Step 3: Calculate total exposure BEFORE bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
  //       const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

  //       // Step 4: Create the bet FIRST
  //       const betData: any = {
  //         userId,
  //         matchId: String(match_id),
  //         amount: normalizedBetValue,
  //         odds: normalizedBetRate,
  //         selectionId: normalizedSelectionId,
  //         betType: bet_type,
  //         betName: bet_name,
  //         marketName: market_name,
  //         marketType: market_type,
  //         betValue: normalizedBetValue,
  //         betRate: normalizedBetRate,
  //         winAmount: normalizedWinAmount,
  //         lossAmount: normalizedLossAmount,
  //         gtype: 'bookmaker',
  //         settlementId: settlement_id,
  //         toReturn: to_return,
  //         status: BetStatus.PENDING,
  //         marketId,
  //         ...(eventId && { eventId }),
  //         metadata: runner_name_2 ? { runner_name_2 } : undefined,
  //       };

  //       if (selid) {
  //         betData.selId = selid;
  //       }

  //       const bet = await tx.bet.create({ data: betData });

  //       // Step 5: Calculate total exposure AFTER bet (across all markets)
  //       // ✅ CRITICAL: Use total exposure delta model (preserves Match Odds, Fancy, other Bookmaker bets)
  //       const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
  //       const exposureDelta = totalExposureAfter - totalExposureBefore;

  //       // Deduct only if exposure increases
  //       if (exposureDelta > 0 && currentBalance < exposureDelta) {
  //         throw new Error(
  //           `Insufficient available balance. ` +
  //           `Balance: ${currentBalance}, Required: ${exposureDelta}`,
  //         );
  //       }

  //       await tx.wallet.update({
  //         where: { userId },
  //         data: {
  //           balance:
  //             exposureDelta > 0
  //               ? currentBalance - exposureDelta
  //               : currentBalance + Math.abs(exposureDelta),
  //           liability: currentLiability + exposureDelta,
  //         },
  //       });

  //       // Step 6: Create transaction log using exposureDelta
  //       await tx.transaction.create({
  //         data: {
  //           walletId: currentWallet.id,
  //           amount: Math.abs(exposureDelta),
  //           type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
  //           description: `Bookmaker bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
  //         },
  //       });

  //       debug.bookmaker_exposure_delta = exposureDelta;
  //       debug.bookmaker_total_exposure_before = totalExposureBefore;
  //       debug.bookmaker_total_exposure_after = totalExposureAfter;
  //       debug.bookmaker_old_balance = currentBalance;
  //       debug.bookmaker_new_balance = exposureDelta > 0
  //         ? currentBalance - exposureDelta
  //         : currentBalance + Math.abs(exposureDelta);
  //       debug.bookmaker_old_liability = currentLiability;
  //       debug.bookmaker_new_liability = currentLiability + exposureDelta;

  //       debug.bookmaker_stake = normalizedBetValue;
  //       debug.bookmaker_odds = normalizedBetRate;
  //       debug.bookmaker_bet_type = bet_type;
  //       debug.bookmaker_exposure_delta = exposureDelta;

  //       return { betId: bet.id };
  //     },
  //     {
  //       maxWait: 15000, // Increased from 10000 to handle complex exposure calculations
  //       timeout: 30000, // Increased from 20000 to prevent transaction timeouts
  //     },
  //   );
  // }

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
    
    // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
    const betLiability = this.calculateLiability(gtype, bet_type, normalizedBetValue, normalizedBetRate);
    
    const normalizedLossAmount = betLiability; // Loss = liability
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
    const to_return = normalizedWinAmount + normalizedLossAmount;

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

          const currentBalance = Number(wallet.balance) || 0;
          const currentLiability = Number(wallet.liability) || 0;

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
          const newExposure = this.calculateExposureByMarketType(allPendingBetsWithNewBet);
          const newNetExposure = newExposure.matchOdds + newExposure.fancy + newExposure.bookmaker;

          debug.new_exposure = newExposure;
          debug.new_net_exposure = newNetExposure;

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
          } else if (actualMarketType === 'bookmaker') {
            debug.bookmaker_old_exposure = oldExposure.bookmaker;
            debug.bookmaker_new_exposure = newExposure.bookmaker;
            debug.bookmaker_exposure_diff = newExposure.bookmaker - oldExposure.bookmaker;
          }
          
          // Add current wallet state for debugging
          debug.current_balance = currentBalance;
          debug.current_liability = currentLiability;
          debug.new_total_exposure = newNetExposure;

          // 🔐 STEP 2.5: FANCY REVERSAL VALIDATION (SCORE-AWARE)
          // Validate if reverse (negative exposureDelta) is allowed for Fancy same-line bets
          // Reverse allowed ONLY when one outcome is already impossible based on current score
          // NOTE: This logic handles same-line reverse (YES @ X + NO @ X) - kept unchanged per requirements
          if (actualMarketType === 'fancy' && exposureDelta < 0 && eventId && normalizedSelectionId) {
            // First check: Is this a double fancy? (YES @ X + NO @ X+1)
            // Double fancy detection is already done above, so if we reach here and exposureDelta < 0,
            // it means double fancy was NOT detected, so we need to check for same-line reverse
            
            // Check if this is a same-line reverse scenario
            // Find existing bets on same selection and same betRate
            const existingSameLineBets = allPendingBets.filter((bet: any) => {
              const betGtype = (bet.gtype || '').toLowerCase();
              return (
                betGtype === 'fancy' &&
                bet.eventId === eventId &&
                bet.selectionId === normalizedSelectionId &&
                bet.betRate === normalizedBetRate
              );
            });

            // Check for same-line opposite bet (reverse scenario)
            const newBetTypeUpper = (bet_type || '').toUpperCase();
            const isReverse = existingSameLineBets.length > 0 && existingSameLineBets.some((bet: any) => {
              const existingBetTypeUpper = (bet.betType || '').toUpperCase();
              return (
                (newBetTypeUpper === 'NO' && (existingBetTypeUpper === 'YES' || existingBetTypeUpper === 'BACK')) ||
                (newBetTypeUpper === 'YES' && (existingBetTypeUpper === 'NO' || existingBetTypeUpper === 'LAY')) ||
                (newBetTypeUpper === 'LAY' && (existingBetTypeUpper === 'YES' || existingBetTypeUpper === 'BACK')) ||
                (newBetTypeUpper === 'BACK' && (existingBetTypeUpper === 'NO' || existingBetTypeUpper === 'LAY'))
              );
            });

            if (isReverse) {
              // Reverse detected: same-line opposite bet
              // Reverse is allowed (exposureDelta can be negative for refund)
              // No score comparison - reverse allowed based on same-line + opposite bet only
              const line = normalizedBetRate;

              // Detect existing YES/NO using .some() (DO NOT use existingSameLineBets[0])
              const hasExistingYes = existingSameLineBets.some((bet: any) => {
                const existingBetTypeUpper = (bet.betType || '').toUpperCase();
                return existingBetTypeUpper === 'YES' || existingBetTypeUpper === 'BACK';
              });
              const hasExistingNo = existingSameLineBets.some((bet: any) => {
                const existingBetTypeUpper = (bet.betType || '').toUpperCase();
                return existingBetTypeUpper === 'NO' || existingBetTypeUpper === 'LAY';
              });
              const isNewYes = newBetTypeUpper === 'YES' || newBetTypeUpper === 'BACK';
              const isNewNo = newBetTypeUpper === 'NO' || newBetTypeUpper === 'LAY';

              // Reverse is allowed (same-line + opposite bet detected)
              // exposureDelta remains negative (refund case)
              debug.fancy_reverse_validation = {
                attempted_reverse: true,
                reverse_allowed: true,
                line,
                hasExistingYes,
                hasExistingNo,
                isNewYes,
                isNewNo,
                exposureDelta,
              };
            } else {
              // Not a reverse scenario (no same-line bets OR different line OR same betType)
              // AND not a double fancy (already checked above)
              // Block negative exposureDelta - no refund allowed
              const originalExposureDelta = exposureDelta;
              exposureDelta = 0;
              
              debug.fancy_reverse_validation = {
                attempted_reverse: false,
                reverse_allowed: false,
                reason: 'No same-line opposite bet and not double fancy - refund blocked',
                line: normalizedBetRate,
                originalExposureDelta,
                exposureDelta_adjusted: exposureDelta,
              };
            }
          }

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

          // 🔐 STEP 7: Update wallet using exposure delta
          // If exposureDelta > 0: Deduct from balance, add to liability
          // If exposureDelta < 0: Refund to balance, reduce liability (hedge/offset case)
          const newBalance = exposureDelta > 0
            ? currentBalance - exposureDelta
            : currentBalance + Math.abs(exposureDelta);
          const newLiability = currentLiability + exposureDelta;

          debug.wallet_before = { balance: currentBalance, liability: currentLiability };
          debug.wallet_after = { balance: newBalance, liability: newLiability };

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


