import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus, MatchStatus, Prisma, TransactionType } from '@prisma/client';
import { CricketIdService } from '../cricketid/cricketid.service';
import { PositionService } from '../positions/position.service';

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cricketIdService: CricketIdService,
    private readonly positionService: PositionService,
  ) {}

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

  async selectExposureBalance(
    userId: string,
    gtype: string,
    _settlement: string,
  ) {
    const { _sum } = await this.prisma.bet.aggregate({
      where: {
        userId,
        status: BetStatus.PENDING,
        gtype,
      },
      _sum: {
        lossAmount: true,
      },
    });

    return _sum?.lossAmount ?? 0;
  }

  async selectBetTotalAmount(userId: string) {
    const { _sum } = await this.prisma.bet.aggregate({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      _sum: {
        lossAmount: true,
      },
    });

    return _sum?.lossAmount ?? 0;
  }

  async get_max_loss(betName, matchId, selectionId, userId: string) {
    const { _sum } = await this.prisma.bet.aggregate({
      where: {
        userId,
        status: BetStatus.PENDING,
        matchId: String(matchId),
        selectionId: Number(selectionId),
        betName,
      },
      _sum: {
        lossAmount: true,
      },
    });

    return _sum?.lossAmount ?? 0;
  }

  async calculateExposureWithNewBet(
    userId: string,
    matchId: number,
    selectionId: number,
    _betType: string,
    _betRate: number,
    betValue: number,
    _gtype: string,
    betName: string,
  ) {
    const previousLoss = await this.get_max_loss(
      betName,
      matchId,
      selectionId,
      userId,
    );
    const additionalLoss = Number(betValue) || 0;
    return previousLoss + additionalLoss;
  }

  async get_total_pending_exposure(userId: string) {
    const { _sum } = await this.prisma.bet.aggregate({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      _sum: {
        lossAmount: true,
      },
    });

    return _sum?.lossAmount ?? 0;
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

    const normalizedLossAmount = Number(loss_amount) || 0;
    const normalizedWinAmount = Number(win_amount) || 0;
    const normalizedBetValue = Number(betvalue) || 0;
    const normalizedBetRate = Number(bet_rate) || 0;
    const normalizedSelectionId = Number(selection_id) || 0;

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

    // 2. WALLET & EXPOSURE
    // ✅ CORRECT BETTING RULE (Industry Standard):
    // Total Credit = Balance + Liability (because liability came from balance)
    // Remaining Credit = Total Credit - Locked Exposure (liability)
    // Exposure Limit = Balance + Liability
    // 
    // IMPORTANT: Wallet balance = CREDIT ONLY (not profit/loss)
    // Profit/Loss is calculated and distributed ONLY during settlement
    // Commission is earned ONLY when bets are settled, not during bet placement
    
    // Get wallet - single source of truth for exposure
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

    // ✅ Calculate total credit and remaining credit correctly
    const total_credit = (wallet.balance ?? 0) + (wallet.liability ?? 0);
    const locked_exposure = wallet.liability ?? 0; // Single source of truth
    const remaining_credit = total_credit - locked_exposure; // This equals balance

    debug.wallet_balance = wallet.balance;
    debug.wallet_liability = wallet.liability;
    debug.total_credit = total_credit;
    debug.locked_exposure = locked_exposure;
    debug.remaining_credit = remaining_credit;

    // 3. REQUIRED AMOUNT CALCULATION WITH BACK/LAY NETTING
    // BETFAIR STANDARD:
    // If user has opposite bets (BACK + LAY) on same selection, net the exposure
    // Example: BACK 1000 + LAY 1000 = 0 exposure (perfect hedge)
    const oppositeBetType = bet_type?.toUpperCase() === 'BACK' ? 'LAY' : 'BACK';
    
    // Find opposite exposure on the same selection
    const oppositeExposure = await this.prisma.bet.aggregate({
      where: {
        userId,
        matchId: String(match_id),
        selectionId: normalizedSelectionId,
        betType: oppositeBetType,
        status: BetStatus.PENDING,
      },
      _sum: { lossAmount: true },
    });

    const oppositeLossAmount = oppositeExposure._sum.lossAmount ?? 0;
    
    // Net the exposure: if opposite bets exist, reduce required amount
    // Example: BACK 1000, existing LAY 500 → net exposure = 500
    // Example: BACK 1000, existing LAY 1000 → net exposure = 0 (perfect hedge)
    const netLoss = Math.max(0, normalizedLossAmount - oppositeLossAmount);
    const required_amount = netLoss;

    debug.required_amount_to_place_bet = required_amount;
    debug.opposite_exposure = oppositeLossAmount;
    debug.net_exposure = netLoss;

    // ✅ Validate remaining credit is sufficient for the bet
    // Use wallet.liability as single source of truth (not recalculating from bets)
    // Always validate against what you actually deduct
    if (required_amount > remaining_credit) {
      throw new HttpException(
        {
          success: false,
          error: 'Insufficient available balance',
          code: 'INSUFFICIENT_FUNDS',
          debug: {
            total_credit,
            balance: wallet.balance,
            liability: wallet.liability,
            remaining_credit,
            requested: normalizedLossAmount,
            required_amount,
          },
        },
        400,
      );
    }

    // 4. LOCK LIABILITY AND CREATE BET IN A SINGLE TRANSACTION
    // This ensures atomicity - if bet creation fails, balance deduction is rolled back
    this.logger.log(`Attempting to place bet for user ${userId}, match ${match_id}, selection ${normalizedSelectionId}`);
    
    try {
      // CRITICAL FIX: Add transaction timeout to prevent "Transaction not found" errors
      // This is especially important with pooled connections (Neon, etc.)
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Step 1: Ensure match exists (update with eventId if provided)
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

          // Step 2: Get current wallet state within transaction (ensure it exists)
          const currentWallet = await tx.wallet.upsert({
            where: { userId },
            update: {},
            create: {
              userId,
              balance: 0,
              liability: 0,
            },
          });

          // Step 3: Validate sufficient balance before creating bet
          // We'll update wallet AFTER creating the bet to ensure accurate total exposure calculation
          const currentBalance = Number(currentWallet.balance) || 0;
          const currentLiability = Number(currentWallet.liability) || 0;
          
          // Validate that we have enough balance to cover the required amount
          // required_amount is the net exposure this bet adds (already accounts for netting)
          if (required_amount > currentBalance) {
            throw new Error(
              `Insufficient available balance to place bet. ` +
              `Balance: ${currentBalance}, Liability: ${currentLiability}, ` +
              `Required: ${required_amount}, Remaining: ${currentBalance}`,
            );
          }

          // Step 4: Create the bet FIRST
          // Build bet data object with conditional selId to handle Prisma client type issues
          const betData: any = {
            userId: userId,
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
            lossAmount: normalizedLossAmount, // Store actual loss amount, not netted value
            gtype,
            settlementId: settlement_id,
            toReturn: to_return,
            status: BetStatus.PENDING,
            ...(marketId && { marketId }),
            ...(eventId && { eventId }),
            metadata: runner_name_2 ? { runner_name_2 } : undefined,
          };

          // Add selId if it exists in the schema (handles Prisma client version differences)
          if (selid) {
            betData.selId = selid;
          }

          const bet = await tx.bet.create({
            data: betData,
          });

          // Step 5: Recalculate total NET exposure from ALL pending bets (including the new one)
          // This ensures wallet.liability accurately reflects the net exposure after BACK/LAY netting
          // We need to calculate net exposure per selection, then sum across all selections
          const allPendingBets = await tx.bet.findMany({
            where: {
              userId,
              status: BetStatus.PENDING,
            },
            select: {
              matchId: true,
              selectionId: true,
              betType: true,
              lossAmount: true,
            },
          });

          // Calculate net exposure per selection (BACK - LAY, then take max with 0)
          const exposureBySelection = new Map<string, { back: number; lay: number }>();
          
          for (const bet of allPendingBets) {
            const key = `${bet.matchId}_${bet.selectionId}`;
            if (!exposureBySelection.has(key)) {
              exposureBySelection.set(key, { back: 0, lay: 0 });
            }
            const exposure = exposureBySelection.get(key)!;
            
            if (bet.betType?.toUpperCase() === 'BACK') {
              exposure.back += bet.lossAmount ?? 0;
            } else if (bet.betType?.toUpperCase() === 'LAY') {
              exposure.lay += bet.lossAmount ?? 0;
            }
          }

          // Calculate total net exposure: sum of max(0, back - lay) for each selection
          let actualTotalExposure = 0;
          for (const [key, exposure] of exposureBySelection.entries()) {
            const netExposure = Math.max(0, exposure.back - exposure.lay);
            actualTotalExposure += netExposure;
          }
          
          // Calculate the difference between actual exposure and current liability
          const exposureDiff = actualTotalExposure - currentLiability;

          debug.current_liability = currentLiability;
          debug.actual_total_exposure = actualTotalExposure;
          debug.exposure_diff = exposureDiff;

          // ✅ Update wallet based on actual total exposure
          if (exposureDiff > 0) {
            // 🔒 Need to lock MORE liability (total exposure increased)
            if (currentBalance < exposureDiff) {
              throw new Error(
                `Insufficient available balance to lock liability. ` +
                `Balance: ${currentBalance}, Required: ${exposureDiff}`,
              );
            }

            const newBalance = currentBalance - exposureDiff;
            const newLiability = actualTotalExposure;

            const updatedWallet = await tx.wallet.update({
              where: { userId },
              data: {
                balance: newBalance,
                liability: newLiability,
              },
              select: {
                id: true,
                balance: true,
                liability: true,
              },
            });

            if (!updatedWallet || updatedWallet.balance === undefined || updatedWallet.liability === undefined) {
              throw new Error('Wallet update failed - values not persisted');
            }

            await tx.transaction.create({
              data: {
                walletId: currentWallet.id,
                amount: exposureDiff,
                type: TransactionType.BET_PLACED,
                description: `Liability increased for ${bet_name} (${bet_type})`,
              },
            });

            debug.wallet_debited = exposureDiff;
            debug.old_balance = currentBalance;
            debug.new_balance = updatedWallet.balance;
            debug.old_liability = currentLiability;
            debug.new_liability = updatedWallet.liability;
          } else if (exposureDiff < 0) {
            // 🔓 RELEASE liability (total exposure decreased - hedge detected)
            // This happens when LAY bet offsets BACK bet (or vice versa)
            // For LAY bets: Credit the bet value (stake) to wallet, not just the exposure difference
            // Example: BACK 100 exists (liability = 100), place LAY 100 → credit bet value (100) to wallet
            const isLayBet = bet_type?.toUpperCase() === 'LAY';
            
            // For LAY bets, credit the bet value (stake); for BACK bets, credit the exposure difference
            const releaseAmount = isLayBet ? normalizedBetValue : Math.abs(exposureDiff);

            const newBalance = currentBalance + releaseAmount;
            const newLiability = actualTotalExposure;

            const updatedWallet = await tx.wallet.update({
              where: { userId },
              data: {
                balance: newBalance,
                liability: newLiability,
              },
              select: {
                id: true,
                balance: true,
                liability: true,
              },
            });

            if (!updatedWallet || updatedWallet.balance === undefined || updatedWallet.liability === undefined) {
              throw new Error('Wallet update failed - values not persisted');
            }

            await tx.transaction.create({
              data: {
                walletId: currentWallet.id,
                amount: releaseAmount,
                type: TransactionType.REFUND,
                description: `Liability released due to hedge (${bet_type} bet offsets existing exposure) - ${isLayBet ? 'bet value credited' : 'exposure difference credited'}`,
              },
            });

            debug.liability_released = releaseAmount;
            debug.bet_value_credited = isLayBet ? normalizedBetValue : undefined;
            debug.exposure_diff_credited = isLayBet ? undefined : Math.abs(exposureDiff);
            debug.old_balance = currentBalance;
            debug.new_balance = updatedWallet.balance;
            debug.old_liability = currentLiability;
            debug.new_liability = updatedWallet.liability;
          } else {
            // exposureDiff === 0: No wallet change needed (perfect match)
            debug.exposure_diff_zero = true;
            debug.current_balance = currentBalance;
            debug.current_liability = currentLiability;
            debug.actual_total_exposure = actualTotalExposure;
          }

          // ✅ Update position (handles BACK/LAY netting automatically)
          // This is CRITICAL for correct P/L calculation and hedge detection
          await this.positionService.updatePositionFromBet(
            {
              userId,
              matchId: String(match_id),
              marketType: market_type || 'MATCH_ODDS', // Default to MATCH_ODDS if not provided
              selectionId: normalizedSelectionId,
              betType: (bet_type?.toUpperCase() || 'BACK') as 'BACK' | 'LAY',
              stake: normalizedBetValue,
              odds: normalizedBetRate,
              runnerName: bet_name,
            },
            tx, // Pass transaction client for atomicity
          );

          return { betId: bet.id };
        },
        {
          maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
          timeout: 20000, // Maximum time the transaction can run (20 seconds)
        },
      );

      debug.bet_id = result.betId;

      // 5. VENDOR API CALL REMOVED
      // The vendor API endpoint /v3/placeBet returns 404 and is not available
      // Internal bet placement works correctly without vendor API
      // If vendor API integration is needed in the future, it can be re-enabled here

      this.logger.log(`Bet placed successfully: ${result.betId} for user ${userId}`);
      return { success: true, debug, remaining_credit };
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

  private async adjustWalletBalance(
    userId: string,
    amount: number,
    type: 'debit' | 'credit',
    description: string,
  ) {
    // CRITICAL FIX: Add transaction timeout to prevent "Transaction not found" errors
    return this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) {
          // Use Error instead of HttpException inside transaction
          throw new Error(`User not found: ${userId}`);
        }

        let wallet = await tx.wallet.findUnique({ where: { userId } });
        if (!wallet) {
          wallet = await tx.wallet.create({
            data: { userId, balance: 0, liability: 0 },
          });
        }

        if (type === 'debit') {
          if (wallet.balance < amount) {
            // Use Error instead of HttpException inside transaction
            throw new Error(
              `Insufficient wallet balance. Balance: ${wallet.balance}, Required: ${amount}`,
            );
          }

        await tx.wallet.update({
          where: { userId },
          data: {
            balance: { decrement: amount },
            liability: { increment: amount }, // <-- VERY IMPORTANT
          },
        });
      } else {
        const walletUpdateData: Prisma.WalletUpdateInput = {
          balance: { increment: amount },
        };

        if (wallet.liability > 0) {
          walletUpdateData.liability = {
            decrement: Math.min(wallet.liability, amount),
          };
        }

        await tx.wallet.update({
          where: { userId },
          data: walletUpdateData,
        });
      }

        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            amount,
            type:
              type === 'debit'
                ? TransactionType.BET_PLACED
                : TransactionType.BET_WON,
            description,
          },
        });
      },
      {
        maxWait: 10000, // Maximum time to wait for a transaction slot (10 seconds)
        timeout: 20000, // Maximum time the transaction can run (20 seconds)
      },
    );
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
}
