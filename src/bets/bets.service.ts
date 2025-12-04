import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PlaceBetDto } from './bets.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus, MatchStatus, Prisma, TransactionType } from '@prisma/client';

@Injectable()
export class BetsService {
  private readonly logger = new Logger(BetsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------- MOCK DATABASE FUNCTIONS ---------------------------- //
  // Replace these with actual TypeORM / Prisma / Sequelize calls

  async selectOneRow(table: string, idField: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

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
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    return {
      fs_id: userId,
      status: 1,
      sports_exp: wallet?.balance ?? 0,
    };
  }

  async selectWalletTotalAmountBetPlcae(userId: string) {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        balance: 0,
      },
    });

    return wallet.balance;
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

  async checkExistingAPICall(
    matchId: number,
    marketName: string,
    betName: string,
    gtype: string,
  ) {
    return this.prisma.bet.count({
      where: {
        matchId: String(matchId),
        marketName,
        betName,
        gtype,
      },
    });
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
    const wallet_balance = await this.selectWalletTotalAmountBetPlcae(userId);
    const current_exposure = await this.selectExposureBalance(
      userId,
      gtype,
      settlement_id,
    );
    const allowed_exposure = await this.selectBetTotalAmount(userId);

    const allowed_exp = userRow.sports_exp;
    const avl_limit = allowed_exp - allowed_exposure;

    if (normalizedLossAmount > avl_limit) {
      throw new HttpException(
        {
          success: false,
          error: 'Exposure Limit crossed. Betting is not allowed.',
          code: 'ACCOUNT_LOCKED',
        },
        400,
      );
    }

    debug.wallet_balance = wallet_balance;
    debug.current_exposure = current_exposure;

    // 3. REQUIRED AMOUNT CALCULATION
    let required_amount = 0;

    if (
      ['match_odds', 'bookmatch', 'bookmaker'].includes(gtype.toLowerCase())
    ) {
      const previous_loss = await this.get_max_loss(
        bet_name,
        match_id,
        normalizedSelectionId,
        userId,
      );
      const new_loss = await this.calculateExposureWithNewBet(
        userId,
        match_id,
        normalizedSelectionId,
        bet_type,
        normalizedBetRate,
        normalizedBetValue,
        gtype,
        bet_name,
      );
      const additional_exposure = new_loss - previous_loss;

      required_amount = additional_exposure > 0 ? additional_exposure : 0;

      debug.previous_possible_loss = previous_loss;
      debug.new_possible_loss = new_loss;
      debug.additional_exposure = additional_exposure;
    } else {
      required_amount = normalizedLossAmount;
    }

    debug.required_amount_to_place_bet = required_amount;

    // 3. WALLET - Pending exposure check
    const pending_exposure = await this.get_total_pending_exposure(userId);
    const available_wallet = wallet_balance - pending_exposure;

    debug.pending_exposure = pending_exposure;
    debug.available_wallet_after_exposure = available_wallet;

    if (available_wallet < required_amount) {
      throw new HttpException(
        {
          success: false,
          error: 'Insufficient available wallet after pending exposures.',
          debug,
        },
        400,
      );
    }

    // Ensure wallet exists before locking liability
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          userId,
          balance: wallet_balance,
          liability: 0,
        },
      });
    }

    debug.wallet_balance = wallet.balance;
    debug.wallet_liability = wallet.liability ?? 0;

    // 4. LOCK LIABILITY AND CREATE BET IN A SINGLE TRANSACTION
    // This ensures atomicity - if bet creation fails, balance deduction is rolled back
    this.logger.log(`Attempting to place bet for user ${userId}, match ${match_id}, selection ${normalizedSelectionId}`);
    
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Step 1: Ensure match exists
        await tx.match.upsert({
          where: { id: String(match_id) },
          update: {},
          create: {
            id: String(match_id),
            homeTeam: bet_name ?? 'Unknown',
            awayTeam: market_name ?? 'Unknown',
            startTime: new Date(),
            status: MatchStatus.LIVE,
          },
        });

        // Step 2: Deduct balance and lock liability (if required)
        if (required_amount > 0) {
          // Ensure wallet exists (upsert to handle edge cases)
          const currentWallet = await tx.wallet.upsert({
            where: { userId },
            update: {},
            create: {
              userId,
              balance: wallet_balance,
              liability: 0,
            },
          });

          if (currentWallet.balance < required_amount) {
            throw new HttpException(
              {
                success: false,
                error: 'Insufficient wallet balance to lock liability.',
                code: 'INSUFFICIENT_FUNDS',
                balance: currentWallet.balance,
                liability: currentWallet.liability,
                required_amount: required_amount,
              },
              400,
            );
          }

          await tx.wallet.update({
            where: { userId },
            data: {
              balance: { decrement: required_amount },
              liability: { increment: required_amount },
            },
          });

          // Create transaction record
          await tx.transaction.create({
            data: {
              walletId: currentWallet.id,
              amount: required_amount,
              type: TransactionType.BET_PLACED,
              description: `Liability locked for ${bet_name}`,
            },
          });

          debug.wallet_debited = required_amount;
        }

        // Step 3: Create the bet
        const bet = await tx.bet.create({
          data: {
            userId: userId,
            matchId: String(match_id),
            amount: normalizedBetValue,
            odds: normalizedBetRate,
            selId: selid,
            selectionId: normalizedSelectionId,
            betType: bet_type,
            betName: bet_name,
            marketName: market_name,
            marketType: market_type,
            betValue: normalizedBetValue,
            betRate: normalizedBetRate,
            winAmount: normalizedWinAmount,
            lossAmount: required_amount,
            gtype,
            settlementId: settlement_id,
            toReturn: to_return,
            status: BetStatus.PENDING,
            metadata: runner_name_2 ? { runner_name_2 } : undefined,
          },
        });

        return { betId: bet.id };
      });

      debug.bet_id = result.betId;

      // 5. UPDATE EXPOSURE (this is just a calculation, doesn't need to be in transaction)
      await this.updateExposureBalance(
        userId,
        required_amount,
        settlement_id,
        gtype,
      );

      // 6. EXTERNAL API CALL IF NECESSARY (non-critical, can fail without affecting bet)
      const existingApi = await this.checkExistingAPICall(
        match_id,
        market_name,
        bet_name,
        gtype,
      );

      if (existingApi == 0) {
        const payload = {
          event_id: match_id,
          event_name: market_name,
          market_id: selid,
          market_name: bet_name,
          market_type: gtype,
        };

        try {
          const response = await axios.post(
            'https://api.cricketid.xyz/placed_bets?key=dijbfuwd719e12rqhfbjdqdnkqnd11&sid=4',
            payload,
            { headers: { 'Content-Type': 'application/json' } },
          );
          debug.external_api_response = response.data;
        } catch (error) {
          debug.external_api_error =
            axios.isAxiosError(error) && error.response
              ? {
                  status: error.response.status,
                  data: error.response.data,
                }
              : { message: (error as Error).message };
        }
      } else {
        debug.external_api_response = 'Skipped – already exists';
      }

      this.logger.log(`Bet placed successfully: ${result.betId} for user ${userId}`);
      return { success: true, debug, avl_limit };
    } catch (error) {
      this.logger.error(`Error placing bet for user ${userId}:`, error);
      
      // If it's already an HttpException, re-throw it
      if (error instanceof HttpException) {
        throw error;
      }

      // For other errors, wrap in a proper error response
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to place bet',
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
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new HttpException(
          {
            success: false,
            error: 'User not found.',
            code: 'USER_NOT_FOUND',
          },
          400,
        );
      }

      let wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId, balance: 0, liability: 0 },
        });
      }

      if (type === 'debit') {
        if (wallet.balance < amount) {
          throw new HttpException(
            {
              success: false,
              error: 'Insufficient wallet balance to lock liability.',
              code: 'INSUFFICIENT_FUNDS',
              balance: wallet.balance,
              liability: wallet.liability,
              required_amount: amount,
            },
            400,
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
    });
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
