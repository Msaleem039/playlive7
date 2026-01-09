import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus, MatchStatus, TransactionType, Prisma, Wallet, Bet } from '@prisma/client';
import { calculatePositions } from '../positions/position.service';

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
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
  private async calculateMatchOddsExposure(
    tx: any,
    userId: string,
    marketId: string,
  ): Promise<number> {
    try {
      const bets = await tx.bet.findMany({
        where: {
          userId,
          marketId,
          status: BetStatus.PENDING,
          gtype: { in: ['matchodds', 'match'] },
        },
        select: {
          betType: true,
          winAmount: true,
          lossAmount: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
          selectionId: true,
        },
      });
    
      // Group by selection (runner) to properly net BACK and LAY bets on same selection
      const selectionMap = new Map<
        number,
        {
          totalBackStake: number;
          totalBackWinAmount: number;
          totalLayLiability: number;
          totalLayStake: number;
        }
      >();

      // Aggregate all bets per selection to enable proper netting
      for (const bet of bets) {
        if (!bet.selectionId) continue;
        
        if (!selectionMap.has(bet.selectionId)) {
          selectionMap.set(bet.selectionId, {
            totalBackStake: 0,
            totalBackWinAmount: 0,
            totalLayLiability: 0,
            totalLayStake: 0,
          });
        }

        const position = selectionMap.get(bet.selectionId)!;
        const stake = bet.betValue || bet.amount || 0;
        const odds = bet.betRate || bet.odds || 0;

        if (bet.betType === 'BACK') {
          // BACK bet: liability = stake, winAmount = stake * odds
          position.totalBackStake += stake;
          position.totalBackWinAmount += bet.winAmount || stake * odds || 0;
        } else if (bet.betType === 'LAY') {
          // LAY bet: liability = (odds - 1) * stake, stake kept if wins
          const layLiability = (odds - 1) * stake;
          position.totalLayLiability += layLiability;
          position.totalLayStake += stake;
        }
      }
    
      // Calculate net exposure per selection, then sum for market
      let marketExposure = 0;

      for (const [selectionId, position] of selectionMap) {
        // Net the BACK and LAY positions on this selection
        // If BACK 100 @ 2.0 and LAY 100 @ 2.0 on same selection:
        // - Net stake: 100 - 100 = 0 → Exposure = 0 (properly offset)
        
        const netStake = position.totalBackStake - position.totalLayStake;

        // Calculate exposure based on net position
        if (netStake > 0) {
          // Net BACK position: exposure = net stake (BACK liability = stake)
          marketExposure += netStake;
        } else if (netStake < 0) {
          // Net LAY position: calculate average odds for remaining LAY bets
          // exposure = (avg odds - 1) * |net stake|
          const avgOdds = position.totalLayStake > 0
            ? (position.totalLayLiability / position.totalLayStake) + 1
            : 1;
          const netLayLiability = (avgOdds - 1) * Math.abs(netStake);
          marketExposure += netLayLiability;
        }
        // If netStake === 0, exposure = 0 (fully offset)
      }
    
      return marketExposure;
    } catch (error: any) {
      // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
      if (error?.message?.includes('Transaction not found') || 
          error?.message?.includes('Transaction ID is invalid') ||
          error?.message?.includes('Transaction already closed')) {
        this.logger.warn(
          `Transaction invalid in calculateMatchOddsExposure for userId: ${userId}, marketId: ${marketId}. Returning 0 exposure.`,
        );
        return 0;
      }
      // Re-throw other errors
      throw error;
    }
  }
  

  /**
   * ✅ FANCY EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates exposure for Fancy market ONLY
   * Liability ALWAYS = stake (for both BACK and LAY)
   * Exposure formula: abs(totalBackStake - totalLayStake)
   * Grouped by marketId (NOT selectionId)
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @param marketId - Market ID
   * @returns Net exposure for this Fancy market
   */
  private async calculateFancyExposure(
    tx: any,
    userId: string,
    eventId: string,
    selectionId: number,
  ): Promise<number> {
    try {
      const bets = await tx.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
          gtype: 'fancy',
          eventId,
          selectionId,
        },
        select: {
          betType: true,
          betValue: true,
          amount: true,
        },
      });

      let totalBackStake = 0;
      let totalLayStake = 0;

      for (const bet of bets) {
        const stake = bet.betValue ?? bet.amount ?? 0;
        const betTypeUpper = (bet.betType || '').toUpperCase();

        // FANCY: liability = stake (for both BACK and LAY)
        // YES/NO are treated the same as BACK/LAY
        if (betTypeUpper === 'BACK' || betTypeUpper === 'YES') {
          totalBackStake += stake;
        } else if (betTypeUpper === 'LAY' || betTypeUpper === 'NO') {
          totalLayStake += stake;
        }
      }

      // Exposure = abs(totalBackStake - totalLayStake)
      return Math.abs(totalBackStake - totalLayStake);
    } catch (error: any) {
      // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
      if (error?.message?.includes('Transaction not found') || 
          error?.message?.includes('Transaction ID is invalid') ||
          error?.message?.includes('Transaction already closed')) {
        this.logger.warn(
          `Transaction invalid in calculateFancyExposure for userId: ${userId}, eventId: ${eventId}, selectionId: ${selectionId}. Returning 0 exposure.`,
        );
        return 0;
      }
      // Re-throw other errors
      throw error;
    }
  }

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
  private async calculateBookmakerExposure(
    tx: any,
    userId: string,
    marketId: string,
  ): Promise<number> {
    try {
      // Query for bookmaker bets: includes 'bookmaker' and numbered match variants (match1, match2, etc.)
      // First, find all bets for this marketId to check gtype patterns
      const allBets = await tx.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
          marketId,
        },
        select: {
          gtype: true,
          betType: true,
          betValue: true,
          amount: true,
          betRate: true,
          odds: true,
        },
      });

      // Filter for bookmaker bets: 'bookmaker' or numbered match variants (match1, match2, etc.)
      const bets = allBets.filter((bet: any) => {
        const betGtype = (bet.gtype || '').toLowerCase();
        return betGtype === 'bookmaker' || 
               (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
      });

      let totalBackStake = 0;
      let totalLayLiability = 0;

      for (const bet of bets) {
        const stake = bet.betValue ?? bet.amount ?? 0;
        const odds = bet.betRate ?? bet.odds ?? 0;
        const betTypeUpper = (bet.betType || '').toUpperCase();

        if (betTypeUpper === 'BACK') {
          // BOOKMAKER BACK: liability = stake
          totalBackStake += stake;
        } else if (betTypeUpper === 'LAY') {
          // BOOKMAKER LAY: liability = (odds - 1) × stake
          totalLayLiability += (odds - 1) * stake;
        }
      }

      // Exposure = abs(totalBackStake - totalLayLiability)
      return Math.abs(totalBackStake - totalLayLiability);
    } catch (error: any) {
      // Handle transaction errors gracefully - return 0 exposure if transaction is invalid
      if (error?.message?.includes('Transaction not found') || 
          error?.message?.includes('Transaction ID is invalid') ||
          error?.message?.includes('Transaction already closed')) {
        this.logger.warn(
          `Transaction invalid in calculateBookmakerExposure for userId: ${userId}, marketId: ${marketId}. Returning 0 exposure.`,
        );
        return 0;
      }
      // Re-throw other errors
      throw error;
    }
  }

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
   * ✅ FIXED: Properly nets BACK and LAY bets on the same selection
   * @param bets - Array of bets for the market
   * @returns Net exposure for this Match Odds market
   */
  private calculateMatchOddsExposureInMemory(bets: any[]): number {
    const selectionMap = new Map<number, {
      backStake: number;
      backWin: number;
      layStake: number;
      layLiability: number;
    }>();
  
    for (const bet of bets) {
      if (!bet.selectionId) continue;
  
      if (!selectionMap.has(bet.selectionId)) {
        selectionMap.set(bet.selectionId, {
          backStake: 0,
          backWin: 0,
          layStake: 0,
          layLiability: 0,
        });
      }
  
      const pos = selectionMap.get(bet.selectionId)!;
      const stake = bet.betValue || 0;
      const odds = bet.betRate || 0;
  
      if (bet.betType === 'BACK') {
        pos.backStake += stake;
        pos.backWin += (odds - 1) * stake;
      }
  
      if (bet.betType === 'LAY') {
        pos.layStake += stake;
        pos.layLiability += (odds - 1) * stake;
      }
    }
  
    let exposure = 0;
  
    for (const pos of selectionMap.values()) {
      const lossIfWin = pos.layLiability - pos.backWin;
      const lossIfLose = pos.backStake - pos.layStake;
  
      exposure += Math.max(lossIfWin, lossIfLose, 0);
    }
  
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
   * @param bets - Array of bets for the fancy selection
   * @returns Net exposure for this Fancy selection
   */
  private calculateFancyExposureInMemory(bets: any[]): number {
    let totalBackStake = 0;
    let totalLayStake = 0;

    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const betTypeUpper = (bet.betType || '').toUpperCase();

      if (betTypeUpper === 'BACK' || betTypeUpper === 'YES') {
        totalBackStake += stake;
      } else if (betTypeUpper === 'LAY' || betTypeUpper === 'NO') {
        totalLayStake += stake;
      }
    }

    return Math.abs(totalBackStake - totalLayStake);
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
  private async placeMatchOddsBet(
    input: PlaceBetDto,
    normalizedBetValue: number,
    normalizedBetRate: number,
    normalizedSelectionId: number,
    normalizedWinAmount: number,
    normalizedLossAmount: number,
    userId: string,
    marketId: string,
    debug: Record<string, unknown>,
  ) {
    const {
      bet_type,
      bet_name,
      match_id,
      market_name,
      market_type,
      eventId,
      runner_name_2,
      selection_id,
    } = input;

    const selid = Math.floor(Math.random() * 90000000) + 10000000;
    const settlement_id = `${match_id}_${selection_id}`;
    const to_return = normalizedWinAmount + normalizedLossAmount;

    return await this.prisma.$transaction(
      async (tx) => {
        // Step 1: Ensure match exists
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

        // Step 2: Get current wallet state
        const currentWallet = await tx.wallet.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            balance: 0,
            liability: 0,
          },
        });

        const currentBalance = Number(currentWallet.balance) || 0;
        const currentLiability = Number(currentWallet.liability) || 0;

        // Step 3: Calculate total exposure BEFORE bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
        // This ensures wallet.liability always matches calculated total exposure across all markets
        // Prevents liability jumps when switching between Match Odds, Fancy, and Bookmaker markets
        const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

        // Step 4: Create the bet FIRST
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
          gtype: 'matchodds',
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

        const bet = await tx.bet.create({ data: betData });

        // Step 5: Calculate total exposure AFTER bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (preserves Fancy, Bookmaker, other Match Odds liability)
        const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
        const exposureDelta = totalExposureAfter - totalExposureBefore;

        // Step 6: Validate balance before updating wallet
        if (exposureDelta > 0 && currentBalance < exposureDelta) {
          throw new Error(
            `Insufficient available balance. ` +
            `Balance: ${currentBalance}, Required: ${exposureDelta}`,
          );
        }

        // Step 7: Update wallet using exposure delta (CRITICAL INVARIANT)
        // 🔐 TOTAL EXPOSURE DELTA MODEL:
        // balance -= exposureDelta (if exposure increases) or += |exposureDelta| (if decreases)
        // liability += exposureDelta (can be positive or negative)
        // Wallet invariant: wallet.liability === calculateTotalExposure(userId)
        // This ensures liability always matches calculated total exposure across all markets
        
        await tx.wallet.update({
          where: { userId },
          data: {
            balance:
              exposureDelta > 0
                ? currentBalance - exposureDelta
                : currentBalance + Math.abs(exposureDelta),
            liability: currentLiability + exposureDelta,
          },
        });

        // Step 8: Create transaction log using exposureDelta
        await tx.transaction.create({
          data: {
            walletId: currentWallet.id,
            amount: Math.abs(exposureDelta),
            type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
            description: `Match Odds bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
          },
        });

        debug.matchodds_exposure_delta = exposureDelta;
        debug.matchodds_total_exposure_before = totalExposureBefore;
        debug.matchodds_total_exposure_after = totalExposureAfter;
        debug.matchodds_old_balance = currentBalance;
        debug.matchodds_new_balance = exposureDelta > 0
          ? currentBalance - exposureDelta
          : currentBalance + Math.abs(exposureDelta);
        debug.matchodds_old_liability = currentLiability;
        debug.matchodds_new_liability = currentLiability + exposureDelta;

        return { betId: bet.id };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  /**
   * @deprecated Use placeBet() instead - All bet placement is now centralized
   */
  private async placeFancyBet(
    input: PlaceBetDto,
    normalizedBetValue: number,
    normalizedBetRate: number,
    normalizedSelectionId: number,
    normalizedWinAmount: number,
    normalizedLossAmount: number,
    userId: string,
    marketId: string,
    debug: Record<string, unknown>,
  ) {
    const {
      bet_type,
      bet_name,
      match_id,
      market_name,
      market_type,
      eventId,
      runner_name_2,
      selection_id,
    } = input;

    const selid = Math.floor(Math.random() * 90000000) + 10000000;
    const settlement_id = `${match_id}_${selection_id}`;
    const to_return = normalizedWinAmount + normalizedLossAmount;

    return await this.prisma.$transaction(
      async (tx) => {
        // Step 1: Ensure match exists
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

        // Step 2: Get current wallet state
        const currentWallet = await tx.wallet.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            balance: 0,
            liability: 0,
          },
        });

        const currentBalance = Number(currentWallet.balance) || 0;
        const currentLiability = Number(currentWallet.liability) || 0;

        // Step 3: Calculate total exposure BEFORE bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
        // This ensures wallet.liability always matches calculated total exposure across all markets
        // Prevents liability jumps when switching between Match Odds, Fancy, and Bookmaker markets
        // Fancy exposure is calculated per (eventId, selectionId) and includes netting
        const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

        // Step 4: Create the bet FIRST
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
          gtype: 'fancy',
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

        const bet = await tx.bet.create({ data: betData });

        // Step 5: Calculate total exposure AFTER bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (preserves Match Odds, Bookmaker, other Fancy liability)
        // Fancy exposure calculation includes netting: BACK 100 + LAY 100 = 0 net exposure
        const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
        const exposureDelta = totalExposureAfter - totalExposureBefore;

        // Step 6: Validate balance before updating wallet
        if (exposureDelta > 0 && currentBalance < exposureDelta) {
          throw new Error(
            `Insufficient available balance. ` +
            `Balance: ${currentBalance}, Required: ${exposureDelta}`,
          );
        }

        // Step 7: Update wallet using exposure delta (CRITICAL INVARIANT)
        // 🔐 TOTAL EXPOSURE DELTA MODEL:
        // balance -= exposureDelta (if exposure increases) or += |exposureDelta| (if decreases)
        // liability += exposureDelta (can be positive or negative due to netting)
        // Wallet invariant: wallet.liability === calculateTotalExposure(userId)
        // This ensures liability always matches calculated total exposure across all markets
        // Fancy bets can have negative exposureDelta when netting reduces total exposure
        
        await tx.wallet.update({
          where: { userId },
          data: {
            balance:
              exposureDelta > 0
                ? currentBalance - exposureDelta
                : currentBalance + Math.abs(exposureDelta),
            liability: currentLiability + exposureDelta,
          },
        });

        // Step 8: Create transaction log using exposureDelta
        await tx.transaction.create({
          data: {
            walletId: currentWallet.id,
            amount: Math.abs(exposureDelta),
            type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
            description: `Fancy bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
          },
        });

        debug.fancy_exposure_delta = exposureDelta;
        debug.fancy_total_exposure_before = totalExposureBefore;
        debug.fancy_total_exposure_after = totalExposureAfter;
        debug.fancy_old_balance = currentBalance;
        debug.fancy_new_balance = exposureDelta > 0
          ? currentBalance - exposureDelta
          : currentBalance + Math.abs(exposureDelta);
        debug.fancy_old_liability = currentLiability;
        debug.fancy_new_liability = currentLiability + exposureDelta;

        return { betId: bet.id };
      },
      {
        maxWait: 15000, // Increased from 10000 to handle complex exposure calculations
        timeout: 30000, // Increased from 20000 to prevent transaction timeouts
      },
    );
  }

  /**
   * @deprecated Use placeBet() instead - All bet placement is now centralized
   */
  private async placeBookmakerBet(
    input: PlaceBetDto,
    normalizedBetValue: number,
    normalizedBetRate: number,
    normalizedSelectionId: number,
    normalizedWinAmount: number,
    normalizedLossAmount: number,
    userId: string,
    marketId: string,
    debug: Record<string, unknown>,
  ) {
    const {
      bet_type,
      bet_name,
      match_id,
      market_name,
      market_type,
      eventId,
      runner_name_2,
      selection_id,
    } = input;

    const selid = Math.floor(Math.random() * 90000000) + 10000000;
    const settlement_id = `${match_id}_${selection_id}`;
    const to_return = normalizedWinAmount + normalizedLossAmount;

    return await this.prisma.$transaction(
      async (tx) => {
        // Step 1: Ensure match exists
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

        // Step 2: Get current wallet state
        const currentWallet = await tx.wallet.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            balance: 0,
            liability: 0,
          },
        });

        const currentBalance = Number(currentWallet.balance) || 0;
        const currentLiability = Number(currentWallet.liability) || 0;

        // Step 3: Calculate total exposure BEFORE bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (not direct stake/liability updates)
        const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

        // Step 4: Create the bet FIRST
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
          gtype: 'bookmaker',
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

        const bet = await tx.bet.create({ data: betData });

        // Step 5: Calculate total exposure AFTER bet (across all markets)
        // ✅ CRITICAL: Use total exposure delta model (preserves Match Odds, Fancy, other Bookmaker bets)
        const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
        const exposureDelta = totalExposureAfter - totalExposureBefore;

        // Deduct only if exposure increases
        if (exposureDelta > 0 && currentBalance < exposureDelta) {
          throw new Error(
            `Insufficient available balance. ` +
            `Balance: ${currentBalance}, Required: ${exposureDelta}`,
          );
        }

        await tx.wallet.update({
          where: { userId },
          data: {
            balance:
              exposureDelta > 0
                ? currentBalance - exposureDelta
                : currentBalance + Math.abs(exposureDelta),
            liability: currentLiability + exposureDelta,
          },
        });

        // Step 6: Create transaction log using exposureDelta
        await tx.transaction.create({
          data: {
            walletId: currentWallet.id,
            amount: Math.abs(exposureDelta),
            type: exposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
            description: `Bookmaker bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDelta}`,
          },
        });

        debug.bookmaker_exposure_delta = exposureDelta;
        debug.bookmaker_total_exposure_before = totalExposureBefore;
        debug.bookmaker_total_exposure_after = totalExposureAfter;
        debug.bookmaker_old_balance = currentBalance;
        debug.bookmaker_new_balance = exposureDelta > 0
          ? currentBalance - exposureDelta
          : currentBalance + Math.abs(exposureDelta);
        debug.bookmaker_old_liability = currentLiability;
        debug.bookmaker_new_liability = currentLiability + exposureDelta;

        debug.bookmaker_stake = normalizedBetValue;
        debug.bookmaker_odds = normalizedBetRate;
        debug.bookmaker_bet_type = bet_type;
        debug.bookmaker_exposure_delta = exposureDelta;

        return { betId: bet.id };
      },
      {
        maxWait: 15000, // Increased from 10000 to handle complex exposure calculations
        timeout: 30000, // Increased from 20000 to prevent transaction timeouts
      },
    );
  }

  // ---------------------------------- MAIN LOGIC (CENTRALIZED MASTER FUNCTION) ---------------------------------- //

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

    try {
      // 🔐 STEP 1: Load wallet & ALL pending bets (SNAPSHOT STATE)
      return await this.prisma.$transaction(
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

          // Load ALL pending bets for exposure calculation
          const allPendingBets = await tx.bet.findMany({
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

          // 🔐 STEP 5: Compute exposure delta
          // delta = oldNetExposure - newNetExposure
          // If delta > 0: exposure increased (deduct from balance, add to liability)
          // If delta < 0: exposure decreased (refund to balance, reduce liability)
          const exposureDelta = newNetExposure - oldNetExposure;

          debug.exposure_delta = exposureDelta;
          debug.market_type = actualMarketType;

          // 🔐 STEP 6: Validate balance (only if exposure is increasing)
          if (exposureDelta > 0 && currentBalance < exposureDelta) {
            throw new Error(
              `Insufficient available balance. ` +
              `Balance: ${currentBalance}, Required: ${exposureDelta}`,
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

          // Calculate positions for match odds & bookmaker markets only (outside transaction)
          let positions: Record<string, number> = {};
          
          if (actualMarketType === 'matchodds' || actualMarketType === 'bookmaker') {
            try {
              // Fetch all pending bets for this user and market (after transaction)
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
                },
              });

              // Filter to only include match odds and bookmaker bets (exclude fancy)
              const relevantBets = pendingBets.filter((bet) => {
                const betGtype = (bet.gtype || '').toLowerCase();
                return (
                  betGtype === 'matchodds' || 
                  betGtype === 'match' ||
                  betGtype === 'bookmaker' ||
                  (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds')
                );
              });

              if (relevantBets.length > 0) {
                // Extract unique selectionIds from filtered bets
                const selectionIds = Array.from(
                  new Set(
                    relevantBets
                      .map((bet) => bet.selectionId)
                      .filter((id) => id !== null && id !== undefined)
                      .map((id) => String(id))
                  )
                );

                if (selectionIds.length > 0) {
                  // Calculate positions using the existing helper function
                  positions = calculatePositions(selectionIds, relevantBets as Bet[]);
                }
              }
            } catch (positionError) {
              // Log error but don't fail bet placement if position calculation fails
              this.logger.warn(
                `Failed to calculate positions for user ${userId}, market ${marketId}:`,
                positionError instanceof Error ? positionError.message : String(positionError),
              );
            }
          }

          return {
            success: true,
            betId: createdBet.id,
            positions,
            debug,
            available_balance: newBalance,
          };
        },
        {
          maxWait: 15000,
          timeout: 30000,
        },
      );
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
        throw new HttpException(
          {
            success: false,
            error: 'Insufficient available balance to lock liability.',
            code: 'INSUFFICIENT_FUNDS',
            debug: {
              ...debug,
              error_details: errorMessage,
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
   * @returns Calculated positions for the market
   */
  async placeBetAndCalculatePositions(
    bet: Partial<Bet> & { userId: string; matchId: string; marketId: string },
    userId: string,
    selections: string[],
  ): Promise<Record<string, number>> {
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

    // 4️⃣ Recalculate authoritative positions
    const authoritativePositions = calculatePositions(selections, pendingBets);

    return authoritativePositions;
  }

  /**
   * Get position details for a user's bets in a specific market
   * 
   * @param userId - User ID
   * @param marketId - Market ID
   * @param marketSelections - Array of selection IDs (as strings) for position calculation
   * @returns Calculated positions for each selection
   */
  async getMarketPositions(
    userId: string,
    marketId: string,
    marketSelections: string[],
  ): Promise<Record<string, number>> {
    // Fetch all pending bets for the market
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        userId,
        marketId,
        status: BetStatus.PENDING,
      },
    });

    // Calculate authoritative positions
    const authoritativePositions = calculatePositions(marketSelections, pendingBets);

    return authoritativePositions;
  }
}
