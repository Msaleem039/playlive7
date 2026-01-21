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
import { MatchOddsExposureService } from './matchodds-exposure.service';
import { BookmakerExposureService } from './bookmaker-exposure.service';
import { FancyExposureService } from './fancy-exposure.service';

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cricketIdService: CricketIdService,
    private readonly matchOddsExposureService: MatchOddsExposureService,
    private readonly bookmakerExposureService: BookmakerExposureService,
    private readonly fancyExposureService: FancyExposureService,
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
      matchOddsExposure += this.matchOddsExposureService.calculateMatchOddsExposureInMemory(marketBets);
    }

    // Calculate Bookmaker exposure (sum across all Bookmaker markets)
    for (const [, marketBets] of bookmakerBetsByMarket) {
      bookmakerExposure += this.bookmakerExposureService.calculateBookmakerExposureInMemory(marketBets);
    }

    // Calculate Fancy exposure (sum across all Fancy selections)
    for (const [, selectionBets] of fancyBetsBySelection) {
      fancyExposure += this.fancyExposureService.calculateFancyExposureInMemory(selectionBets);
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


 


  
  

  /**
   * Calculate Bookmaker exposure in memory (no database queries)
   * @param bets - Array of bets for the market
   * @returns Net exposure for this Bookmaker market
   */



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

    // ✅ FIXED: Fancy LAY bets use loss_amount from payload if provided
    if (betGtype === 'fancy') {
      const upperBetType = bet_type?.toUpperCase();
      
      if (upperBetType === 'NO' || upperBetType === 'LAY') {
        // Fancy LAY: Use loss_amount from payload if provided, otherwise calculate
        const payloadLossAmount = Number(loss_amount) || 0;
        if (payloadLossAmount > 0) {
          normalizedLossAmount = payloadLossAmount;
        } else {
          // Fallback to calculated liability
          normalizedLossAmount = this.calculateLiability(
            gtype,
            bet_type,
            normalizedBetValue,
            normalizedBetRate
          );
        }
      } else {
        // Fancy YES/BACK: Use calculated liability
        normalizedLossAmount = this.calculateLiability(
          gtype,
          bet_type,
          normalizedBetValue,
          normalizedBetRate
        );
      }
    }

    // Bookmaker keeps old behavior
    if (betGtype === 'bookmaker') {
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
    // TODO: Re-enable validation for production
    // Temporarily disabled for testing Gola Fancy with dummy data
    /*
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
    */

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

          // 🔐 STEP 1: Load pending bets for SAME marketId
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
              // @ts-ignore - isRangeConsumed will be available after Prisma client regeneration
              isRangeConsumed: true,
            } as any,
          });

          // 🔐 STEP 2: Do NOT calculate snapshot exposure for wallet
          // Snapshot may exist ONLY for debug

          // 🔐 STEP 3: Create new bet object in memory
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

          // 🔐 STEP 4: Calculate isolated deltas
          let matchOddsDelta = 0;
          let fancyDelta = 0;
          let bookmakerDelta = 0;

          if (actualMarketType === 'matchodds') {
            // ✅ MATCH ODDS OFFSET (BACK ↔ LAY both directions)
            matchOddsDelta = this.matchOddsExposureService.calculateMatchOddsExposureDelta(
              allPendingBets,
              newBet,
            );
          } else if (actualMarketType === 'fancy') {
            // ✅ FANCY DELTA using Maximum Possible Loss model
            // Use calculateFancyGroupDeltaSafe to isolate by group (marketId + selectionId)
            const fancyResult = this.fancyExposureService.calculateFancyGroupDeltaSafe(
              allPendingBets,
              newBet,
            );
            fancyDelta = fancyResult.delta;
            // Note: isRangeConsumed is no longer used in Maximum Possible Loss model
          } else if (actualMarketType === 'bookmaker') {
            // ✅ BOOKMAKER DELTA (isolated by marketId)
            const allBetsWithNewBet = [...allPendingBets, newBet];
            bookmakerDelta = this.bookmakerExposureService.calculateBookmakerExposureDelta(
              allPendingBets,
              allBetsWithNewBet,
              marketId,
            );
          }

          // FINAL exposureDelta = sum of individual deltas
          const exposureDelta = matchOddsDelta + fancyDelta + bookmakerDelta;

          // Debug: Calculate snapshot exposure for logging only (NOT for wallet update)
          const oldExposure = this.calculateExposureByMarketType(allPendingBets);
          const allPendingBetsWithNewBet = [...allPendingBets, newBet];
          const newExposure = this.calculateExposureByMarketType(allPendingBetsWithNewBet);
          const oldNetExposure = oldExposure.matchOdds + oldExposure.fancy + oldExposure.bookmaker;
          const newNetExposure = newExposure.matchOdds + newExposure.fancy + newExposure.bookmaker;

          debug.old_exposure = oldExposure;
          debug.old_net_exposure = oldNetExposure;
          debug.new_exposure = newExposure;
          debug.new_net_exposure = newNetExposure;
          debug.deltas = {
            matchOdds: matchOddsDelta,
            fancy: fancyDelta,
            bookmaker: bookmakerDelta,
            total: exposureDelta,
          };

          // 🔐 STEP 5: Validate balance ONLY if exposureDelta > 0
          if (exposureDelta > 0 && currentBalance < exposureDelta) {
            throw new Error(
              `Insufficient balance. Required=${exposureDelta}, Available=${currentBalance}`,
            );
          }

          // 🔐 STEP 6: Update wallet EXACTLY ONCE using exposureDelta
          const updatedBalance =
            exposureDelta > 0
              ? currentBalance - exposureDelta
              : currentBalance + Math.abs(exposureDelta);

          const updatedLiability = currentLiability + exposureDelta;

          await tx.wallet.update({
            where: { userId },
            data: {
              balance: updatedBalance,
              liability: updatedLiability,
            },
          });

          debug.wallet = {
            before: { balance: currentBalance, liability: currentLiability },
            after: { balance: updatedBalance, liability: updatedLiability },
            exposureDelta,
          };

          // 🔐 STEP 7: Persist bet
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
          // await tx.wallet.update({
          //   where: { userId },
          //   data: {
          //     balance: newBalance,
          //     liability: newLiability,
          //   },
          // });

          // 🔐 STEP 8: Create transaction log
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
            `Deltas: MO=${matchOddsDelta}, Fancy=${fancyDelta}, BM=${bookmakerDelta}, Total=${exposureDelta}. ` +
            `Old Exposure: MO=${oldExposure.matchOdds}, Fancy=${oldExposure.fancy}, BM=${oldExposure.bookmaker} (Net: ${oldNetExposure}). ` +
            `New Exposure: MO=${newExposure.matchOdds}, Fancy=${newExposure.fancy}, BM=${newExposure.bookmaker} (Net: ${newNetExposure}).`,
          );

          // Return bet info - position calculation happens AFTER transaction commits
          return {
            success: true,
            betId: createdBet.id,
            debug,
            available_balance: updatedBalance,
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


