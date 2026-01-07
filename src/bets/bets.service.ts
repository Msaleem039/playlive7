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
   * ✅ MARKET-WISE EXPOSURE KEY (EXCHANGE ACCURATE)
   * 
   * Exposure MUST be grouped by MARKET, not selection
   * - Match Odds: marketId
   * - Bookmaker: marketId
   * - Fancy: marketId (NOT selectionId)
   * 
   * @param bet - Bet object with gtype and marketId
   * @returns Exposure key in format: "gtype:marketId"
   */
  private getExposureKey(bet: {
    gtype?: string | null;
    marketId?: string | null;
    eventId?: string | null;
  }): string {
    if (!bet.marketId) {
      throw new Error('marketId is REQUIRED for exchange exposure calculation');
    }
    const normalizedGtype = (bet.gtype || '').toLowerCase();
    return `${normalizedGtype}:${bet.marketId}`;
  }

  /**
   * ✅ MATCH ODDS EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates exposure for Match Odds market ONLY
   * Exposure formula: abs(totalBackStake - totalLayLiability)
   * Grouped by marketId (NOT selectionId)
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
          selectionId: true,
        },
      });
    
      /**
       * Group by selection (runner)
       */
      const selectionMap = new Map<
        number,
        {
          profitIfWin: number;
          profitIfLose: number;
        }
      >();
    
      for (const bet of bets) {
        if (!selectionMap.has(bet.selectionId)) {
          selectionMap.set(bet.selectionId, {
            profitIfWin: 0,
            profitIfLose: 0,
          });
        }
    
        const pnl = selectionMap.get(bet.selectionId)!;
    
        if (bet.betType === 'BACK') {
          pnl.profitIfWin += bet.winAmount;
          pnl.profitIfLose -= bet.lossAmount;
        } else {
          // LAY
          pnl.profitIfWin -= bet.lossAmount;
          pnl.profitIfLose += bet.betValue;
        }
      }
    
      let marketExposure = 0;
    
      for (const [, pnl] of selectionMap) {
        const worstLoss = Math.min(pnl.profitIfWin, pnl.profitIfLose, 0);
        marketExposure += Math.abs(worstLoss);
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
    marketId: string,
  ): Promise<number> {
    try {
      const bets = await tx.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
          gtype: 'fancy',
          marketId,
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
          `Transaction invalid in calculateFancyExposure for userId: ${userId}, marketId: ${marketId}. Returning 0 exposure.`,
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
   * ✅ TOTAL EXPOSURE ACROSS ALL MARKETS (SUM OF MARKET-SPECIFIC EXPOSURES)
   * 
   * Calculates total exposure by summing market-specific exposures
   * Each market type uses its own exposure calculation logic
   * 
   * @param tx - Prisma transaction client
   * @param userId - User ID
   * @returns Total net exposure across all markets
   */
  private async calculateTotalExposure(tx: any, userId: string): Promise<number> {
    try {
      // Get all unique marketIds grouped by gtype
      const bets = await tx.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
        },
        select: {
          gtype: true,
          marketId: true,
        },
        distinct: ['gtype', 'marketId'],
      });

      let totalExposure = 0;

      for (const bet of bets) {
        if (!bet.marketId) continue;

        const gtype = (bet.gtype || '').toLowerCase();
        const marketId = bet.marketId;

        // Handle "match" as alias for "matchodds"
        if (gtype === 'matchodds' || gtype === 'match') {
          totalExposure += await this.calculateMatchOddsExposure(tx, userId, marketId);
        } else if (gtype === 'fancy') {
          totalExposure += await this.calculateFancyExposure(tx, userId, marketId);
        } else if (gtype === 'bookmaker' || 
                   (gtype.startsWith('match') && gtype !== 'match' && gtype !== 'matchodds')) {
          // Handle "match1", "match2", etc. as bookmaker (numbered match markets are bookmaker)
          totalExposure += await this.calculateBookmakerExposure(tx, userId, marketId);
        }
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

  // ---------------------------- MOCK DATABASE FUNCTIONS ---------------------------- //
  // Replace these with actual TypeORM / Prisma / Sequelize calls

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

  async selectWalletTotalAmountBetPlcae(userId: string) {
    // Get wallet balance (credit only, not profit/loss)
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        balance: 0,
      },
    });

    return wallet.balance; // Returns available credit
  }

  // REAL CRICKET EXCHANGE RULES:
  // - BACK bet: liability = stake
  // - LAY bet: liability = (odds - 1) * stake
  async selectExposureBalance(
    userId: string,
    gtype: string,
    _settlement: string,
  ) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
        gtype,
      },
      select: {
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
        gtype: true,
      },
    });

    let totalExposure = 0;
    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      const betGtype = bet.gtype || gtype; // Use bet's gtype or fallback to parameter
      
      // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
      const liability = this.calculateLiability(betGtype, bet.betType, stake, odds);
      totalExposure += liability;
    }

    return totalExposure;
  }

  async selectBetTotalAmount(userId: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      select: {
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
        gtype: true,
      },
    });

    let totalExposure = 0;
    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      
      // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
      const liability = this.calculateLiability(bet.gtype, bet.betType, stake, odds);
      totalExposure += liability;
    }

    return totalExposure;
  }

  async get_max_loss(betName, matchId, selectionId, userId: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
        matchId: String(matchId),
        selectionId: Number(selectionId),
        betName,
      },
      select: {
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
        gtype: true,
      },
    });

    let totalExposure = 0;
    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      
      // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
      const liability = this.calculateLiability(bet.gtype, bet.betType, stake, odds);
      totalExposure += liability;
    }

    return totalExposure;
  }

  async calculateExposureWithNewBet(
    userId: string,
    matchId: number,
    selectionId: number,
    betType: string,
    betRate: number,
    betValue: number,
    gtype: string,
    betName: string,
  ) {
    // REAL CRICKET EXCHANGE: Calculate net exposure using liabilities
    // FANCY: liability = stake (for both BACK and LAY)
    // BOOKMAKER / MATCH ODDS: BACK liability = stake, LAY liability = (odds - 1) * stake
    const existingBets = await this.prisma.bet.findMany({
      where: {
        userId,
        matchId: String(matchId),
        selectionId: Number(selectionId),
        betName,
        status: BetStatus.PENDING,
      },
      select: {
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
        gtype: true,
      },
    });

    let backLiability = 0;
    let layLiability = 0;

    for (const bet of existingBets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      const betTypeUpper = bet.betType?.toUpperCase();
      
      // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
      const liability = this.calculateLiability(bet.gtype, bet.betType, stake, odds);
      
      if (betTypeUpper === 'BACK') {
        backLiability += liability;
      } else if (betTypeUpper === 'LAY') {
        layLiability += liability;
      }
    }

    // Add new bet liability (using gtype parameter)
    const normalizedBetValue = Number(betValue) || 0;
    const normalizedBetRate = Number(betRate) || 0;
    const betTypeUpper = betType?.toUpperCase();
    
    // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
    const newBetLiability = this.calculateLiability(gtype, betType, normalizedBetValue, normalizedBetRate);
    
    if (betTypeUpper === 'BACK') {
      backLiability += newBetLiability;
    } else if (betTypeUpper === 'LAY') {
      layLiability += newBetLiability;
    }

    // Net exposure = absolute difference of liabilities
    return Math.abs(backLiability - layLiability);
  }

  async get_total_pending_exposure(userId: string) {
    // REAL CRICKET EXCHANGE: Calculate total net exposure across all bets
    // FANCY: liability = stake (for both BACK and LAY)
    // BOOKMAKER / MATCH ODDS: BACK liability = stake, LAY liability = (odds - 1) * stake
    const allBets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      select: {
        matchId: true,
        selectionId: true,
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
        gtype: true,
      },
    });

    // Group by selection and calculate net exposure using liabilities
    const exposureBySelection = new Map<string, { back: number; lay: number }>();
    
    for (const bet of allBets) {
      const key = `${bet.matchId}_${bet.selectionId}`;
      if (!exposureBySelection.has(key)) {
        exposureBySelection.set(key, { back: 0, lay: 0 });
      }
      const exposure = exposureBySelection.get(key)!;
      
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      const betTypeUpper = bet.betType?.toUpperCase();
      
      // ✅ EXCHANGE-ACCURATE: Use helper function for consistent liability calculation
      const liability = this.calculateLiability(bet.gtype, bet.betType, stake, odds);
      
      // Add to appropriate exposure bucket
      if (betTypeUpper === 'BACK') {
        exposure.back += liability;
      } else if (betTypeUpper === 'LAY') {
        exposure.lay += liability;
      }
    }

    // Total exposure = sum of absolute differences of liabilities
    let totalExposure = 0;
    for (const [key, exposure] of exposureBySelection.entries()) {
      totalExposure += Math.abs(exposure.back - exposure.lay);
    }

    return totalExposure;
  }

  async insertBet(data) {
    const bet = await this.prisma.bet.create({
      data,
    });

    return { insertId: bet.id };
  }

  async updateExposureBalance(
    userId: string,
    value: number,
    settlement: string,
    gtype: string,
  ) {
    return this.selectExposureBalance(userId, gtype, settlement);
  }


  // ---------------------------------- MARKET-SPECIFIC BET PLACEMENT ---------------------------------- //

  /**
   * ✅ MATCH ODDS BET PLACEMENT (MARKET-SPECIFIC)
   * 
   * Exchange Rules:
   * - BACK: liability = stake
   * - LAY: liability = (odds - 1) × stake
   * - Exposure grouped by marketId (NOT selectionId)
   * - Exposure formula: abs(totalBackStake - totalLayLiability)
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
        // ✅ CRITICAL: Calculate total exposure BEFORE creating bet
        const totalExposureBefore = await this.calculateTotalExposure(tx, userId);

        // Step 4: Create the bet
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

        // Step 5: Calculate exposure AFTER bet
        const totalExposureAfter = await this.calculateTotalExposure(tx, userId);
        const exposureDiff = totalExposureAfter - totalExposureBefore;

        debug.matchodds_old_exposure = totalExposureBefore;
        debug.matchodds_new_exposure = totalExposureAfter;
        debug.matchodds_exposure_diff = exposureDiff;

        // Step 6: Update wallet using exposureDiff (CRITICAL INVARIANT)
        // Wallet invariant: balance + liability = constant
        // exposureDiff = change in total liability
        // If exposureDiff > 0: debit balance, increase liability
        // If exposureDiff < 0: credit balance, decrease liability
        if (exposureDiff > 0) {
          if (currentBalance < exposureDiff) {
            throw new Error(
              `Insufficient available balance. ` +
              `Balance: ${currentBalance}, Required: ${exposureDiff}, ` +
              `Current Liability: ${currentLiability}, New Total Exposure: ${totalExposureAfter}`,
            );
          }

          await tx.wallet.update({
            where: { userId },
            data: {
              balance: currentBalance - exposureDiff,
              liability: totalExposureAfter,
            },
          });

          await tx.transaction.create({
            data: {
              walletId: currentWallet.id,
              amount: exposureDiff,
              type: TransactionType.BET_PLACED,
              description: `Match Odds bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Exposure Change: ${exposureDiff}`,
            },
          });
        } else if (exposureDiff < 0) {
          const creditAmount = Math.abs(exposureDiff);
          await tx.wallet.update({
            where: { userId },
            data: {
              balance: currentBalance + creditAmount,
              liability: totalExposureAfter,
            },
          });

          await tx.transaction.create({
            data: {
              walletId: currentWallet.id,
              amount: creditAmount,
              type: TransactionType.REFUND,
              description: `Match Odds hedge detected - Amount credited: ${creditAmount}`,
            },
          });
        }

        return { betId: bet.id };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  /**
   * ✅ FANCY BET PLACEMENT (MARKET-SPECIFIC)
   * 
   * Exchange Rules:
   * - BACK: liability = stake
   * - LAY: liability = stake (NOT (odds - 1) × stake)
   * - Exposure grouped by marketId (NOT selectionId)
   * - Exposure formula: abs(totalBackStake - totalLayStake)
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

        // Step 3: Create the bet FIRST
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

        // Step 4: Fancy wallet update with YES/NO netting
        // ✅ EXCHANGE RULE: Fancy liability ALWAYS = stake (for both BACK and LAY)
        // Every Fancy bet adds exactly `stake` to liability
        // Wallet invariant: balance + liability = constant
        
        // ✅ Recalculate total fancy exposure AFTER bet creation
        const newExposure = await this.calculateFancyExposure(
          tx,
          userId,
          marketId,
        );

        const exposureDelta = newExposure - currentLiability;

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
              exposureDelta >= 0
                ? currentBalance - exposureDelta
                : currentBalance + Math.abs(exposureDelta),
            liability: newExposure,
          },
        });

        const stake = normalizedBetValue;
        await tx.transaction.create({
          data: {
            walletId: currentWallet.id,
            amount: Math.abs(exposureDelta),
            type: TransactionType.BET_PLACED,
            description:
              exposureDelta > 0
                ? `Fancy bet placed (net): ${bet_name} (${bet_type}) - Stake: ${exposureDelta}`
                : `Fancy bet offset: ${bet_name} (${bet_type})`,
          },
        });

        debug.fancy_stake = stake;
        debug.fancy_old_balance = currentBalance;
        debug.fancy_new_balance =
          exposureDelta >= 0
            ? currentBalance - exposureDelta
            : currentBalance + Math.abs(exposureDelta);
        debug.fancy_old_liability = currentLiability;
        debug.fancy_new_liability = newExposure;

        return { betId: bet.id };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  /**
   * ✅ BOOKMAKER BACK BET PLACEMENT (SEPARATE FUNCTION)
   * 
   * 🔐 CRITICAL: This function handles Bookmaker BACK bet placement ONLY.
   * It does NOT reuse Match Odds or Fancy logic.
   * 
   * Exchange Rules for Bookmaker BACK:
   * - Deduct stake from balance
   * - Add stake to liability
   * - No exposure calculation needed (direct stake/liability update)
   * 
   * ⚠️ ATOMIC UPDATE: Re-reads wallet inside function to avoid stale snapshot issues.
   * Uses atomic increment/decrement operations for thread-safe updates.
   */
  private async placeBookmakerBackBet({
    tx,
    userId,
    stake,
  }: {
    tx: Prisma.TransactionClient;
    userId: string;
    stake: number;
  }): Promise<void> {
    // 🔐 CRITICAL: Re-read wallet inside function to get latest state (avoid stale snapshot)
    const wallet = await tx.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new BadRequestException(`Wallet not found for user ${userId}`);
    }

    const currentBalance = Number(wallet.balance) || 0;
    if (currentBalance < stake) {
      throw new BadRequestException(
        `Insufficient balance. Balance: ${currentBalance}, Required: ${stake}`,
      );
    }

    // ✅ ATOMIC UPDATE: Use increment/decrement (NOT direct assignment from stale snapshot)
    await tx.wallet.update({
      where: { userId },
      data: {
        balance: { decrement: stake },   // ✅ ATOMIC: Deduct stake
        liability: { increment: stake }, // ✅ ATOMIC: Add stake to liability
      },
    });
  }

  /**
   * ✅ BOOKMAKER LAY BET PLACEMENT (SEPARATE FUNCTION)
   * 
   * 🔐 CRITICAL: This function handles Bookmaker LAY bet placement ONLY.
   * 
   * Exchange Rules for Bookmaker LAY:
   * - Deduct liability from balance: (stake * odds) / 100
   * - Add liability to liability
   * - Uses percentage-based odds (not decimal)
   * 
   * ⚠️ ATOMIC UPDATE: Re-reads wallet inside function to avoid stale snapshot issues.
   * Uses atomic increment/decrement operations for thread-safe updates.
   */
  private async placeBookmakerLayBet({
    tx,
    userId,
    stake,
    odds,
  }: {
    tx: Prisma.TransactionClient;
    userId: string;
    stake: number;
    odds: number;
  }): Promise<void> {
    // ✅ CORRECT: Bookmaker LAY liability uses percentage-based odds
    const liability = (stake * odds) / 100;
    const roundedLiability = Math.round(liability * 100) / 100;

    // 🔐 CRITICAL: Re-read wallet inside function to get latest state (avoid stale snapshot)
    const wallet = await tx.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new BadRequestException(`Wallet not found for user ${userId}`);
    }

    const currentBalance = Number(wallet.balance) || 0;
    if (currentBalance < roundedLiability) {
      throw new BadRequestException(
        `Insufficient balance. Balance: ${currentBalance}, Required: ${roundedLiability}`,
      );
    }

    // ✅ ATOMIC UPDATE: Use increment/decrement (NOT direct assignment from stale snapshot)
    await tx.wallet.update({
      where: { userId },
      data: {
        balance: { decrement: roundedLiability },   // ✅ ATOMIC: Deduct liability
        liability: { increment: roundedLiability }, // ✅ ATOMIC: Add liability
      },
    });
  }

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

        // Step 3: Create the bet FIRST
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

        // Step 4: Update wallet using Bookmaker-specific placement functions
        // ✅ CORRECT: Bookmaker uses direct stake/liability updates (NO exposure calculation)
        const betTypeUpper = bet_type?.toUpperCase();
        let walletUpdateAmount = 0;

        if (betTypeUpper === 'BACK') {
          // ✅ Use separate BACK bet placement function (re-reads wallet internally)
          await this.placeBookmakerBackBet({
            tx,
            userId,
            stake: normalizedBetValue,
          });
          walletUpdateAmount = normalizedBetValue;
        } else if (betTypeUpper === 'LAY') {
          // ✅ Use separate LAY bet placement function (re-reads wallet internally)
          await this.placeBookmakerLayBet({
            tx,
            userId,
            stake: normalizedBetValue,
            odds: normalizedBetRate,
          });
          // LAY liability = (stake * odds) / 100
          walletUpdateAmount = (normalizedBetValue * normalizedBetRate) / 100;
          walletUpdateAmount = Math.round(walletUpdateAmount * 100) / 100;
        } else {
          throw new BadRequestException(
            `Invalid bet type for Bookmaker: ${bet_type}. Must be BACK or LAY.`,
          );
        }

        // Step 5: Create transaction record
        await tx.transaction.create({
          data: {
            walletId: currentWallet.id,
            amount: walletUpdateAmount,
            type: TransactionType.BET_PLACED,
            description: `Bookmaker bet placed: ${bet_name} (${bet_type}) - Stake: ${normalizedBetValue}, Amount: ${walletUpdateAmount}`,
          },
        });

        debug.bookmaker_stake = normalizedBetValue;
        debug.bookmaker_odds = normalizedBetRate;
        debug.bookmaker_bet_type = bet_type;
        debug.bookmaker_wallet_update = walletUpdateAmount;

        return { betId: bet.id };
      },
      {
        maxWait: 10000,
        timeout: 20000,
      },
    );
  }

  // ---------------------------------- MAIN LOGIC ---------------------------------- //

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
    const status = BetStatus.PENDING;
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

    // 2. WALLET & EXPOSURE (REAL CRICKET EXCHANGE RULES)
    // ✅ EXCHANGE RULES:
    // - Available Balance = Balance - Liability (locked funds)
    // - BACK bet: liability = stake
    // - LAY bet: liability = (odds - 1) * stake
    // - Balance is debited by liability amount when placing a bet
    
    // Get wallet
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          userId,
          balance: 0,
          liability: 0,
        },
      });
    }

    // Available balance = wallet balance (liability is tracked separately)
    // Liability represents total locked exposure across all pending bets
    const available_balance = wallet.balance ?? 0;
    const total_exposure = wallet.liability ?? 0; // Total locked exposure

    debug.wallet_balance = wallet.balance;
    debug.wallet_liability = wallet.liability;
    debug.available_balance = available_balance;
    debug.total_exposure = total_exposure;

    // 3. VALIDATE MARKET ID (REQUIRED FOR EXCHANGE EXPOSURE)
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

    debug.bet_liability = betLiability;
    debug.bet_type = bet_type;
    debug.bet_value = normalizedBetValue;
    debug.bet_rate = normalizedBetRate;
    debug.stake = normalizedBetValue;
    debug.gtype = gtype;
    debug.marketId = marketId;

    // 4. ROUTE TO MARKET-SPECIFIC BET PLACEMENT FUNCTION
    // Each market type has its own exposure calculation logic (NOT shared)
    this.logger.log(`Attempting to place bet for user ${userId}, match ${match_id}, selection ${normalizedSelectionId}, gtype: ${gtype}`);
    
    try {
      const normalizedGtype = (gtype || '').toLowerCase();
      const marketName = (input.market_name || '').toLowerCase();
      let result;

      // Determine market type with fallback to market_name
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
        // ✅ MATCH ODDS: Separate function with market-specific exposure logic
        result = await this.placeMatchOddsBet(
          input,
          normalizedBetValue,
          normalizedBetRate,
          normalizedSelectionId,
          normalizedWinAmount,
          normalizedLossAmount,
          userId,
          marketId,
          debug,
        );
      } else if (actualMarketType === 'fancy') {
        // ✅ FANCY: Separate function with market-specific exposure logic
        result = await this.placeFancyBet(
          input,
          normalizedBetValue,
          normalizedBetRate,
          normalizedSelectionId,
          normalizedWinAmount,
          normalizedLossAmount,
          userId,
          marketId,
          debug,
        );
      } else if (actualMarketType === 'bookmaker') {
        // ✅ BOOKMAKER: Separate function with market-specific exposure logic
        result = await this.placeBookmakerBet(
          input,
          normalizedBetValue,
          normalizedBetRate,
          normalizedSelectionId,
          normalizedWinAmount,
          normalizedLossAmount,
          userId,
          marketId,
          debug,
        );
      } else {
        throw new HttpException(
          {
            success: false,
            error: `Unsupported market type: ${gtype}. Supported types: match/matchodds, match1/match2/etc (bookmaker), fancy, bookmaker`,
            code: 'UNSUPPORTED_MARKET_TYPE',
          },
          400,
        );
      }

      debug.bet_id = result.betId;

      // 5. VENDOR API CALL REMOVED
      // The vendor API endpoint /v3/placeBet returns 404 and is not available
      // Internal bet placement works correctly without vendor API
      // If vendor API integration is needed in the future, it can be re-enabled here

      this.logger.log(`Bet placed successfully: ${result.betId} for user ${userId}`);

      // Calculate positions for match odds & bookmaker markets only
      let positions: Record<string, number> = {};
      
      // Only calculate positions for match odds and bookmaker markets (exclude fancy)
      if (actualMarketType === 'matchodds' || actualMarketType === 'match' || actualMarketType === 'bookmaker') {
        try {
          // Fetch all pending bets for this user and market
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
            // Extract unique selectionIds from filtered bets to use as selections array
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
        betId: result.betId,
        positions,
        debug, 
        available_balance: wallet.balance 
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

  private async ensureMatchExists(
    matchId: string,
    marketName?: string,
    betName?: string,
  ) {
    await this.prisma.match.upsert({
      where: { id: matchId },
      update: {},
      create: {
        id: matchId,
        homeTeam: betName ?? 'Unknown',
        awayTeam: marketName ?? 'Unknown',
        startTime: new Date(),
        status: MatchStatus.LIVE,
      },
    });
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
