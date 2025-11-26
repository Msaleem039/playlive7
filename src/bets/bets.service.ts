import { HttpException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { PlaceBetDto } from './bets.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BetStatus, MatchStatus, TransactionType } from '@prisma/client';

@Injectable()
export class BetsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------- MOCK DATABASE FUNCTIONS ---------------------------- //
  // Replace these with actual TypeORM / Prisma / Sequelize calls

  async selectOneRow(table: string, idField: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true, id: true },
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

    return { fs_id: userId, status: 1, sports_exp: user.balance ?? 0 };
  }

  async selectWalletTotalAmountBetPlcae(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, balance: true },
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

    const wallet = await this.prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        balance: user.balance ?? 0,
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
      return {
        success: false,
        error: 'Exposure Limit crossed.',
        code: 'ACCOUNT_LOCKED',
      };
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

      debug.previous_loss = previous_loss;
      debug.new_loss = new_loss;
      debug.additional_exposure = additional_exposure;
    } else {
      required_amount = normalizedLossAmount;
    }

    debug.required_amount = required_amount;

    // 4. WALLET PENDING EXPOSURE
    const pending_exposure = await this.get_total_pending_exposure(userId);
    const available_wallet = wallet_balance - pending_exposure;

    debug.pending_exposure = pending_exposure;

    if (available_wallet < required_amount) {
      return {
        success: false,
        error: 'Insufficient wallet balance.',
        code: 'INSUFFICIENT_FUNDS',
        current_balance: wallet_balance,
        required_amount,
        debug,
      };
    }

    // 5. INSERT BET
    await this.ensureMatchExists(String(match_id), market_name, bet_name);

    const insertResult = await this.insertBet({
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
      lossAmount: normalizedLossAmount,
      gtype,
      settlementId: settlement_id,
      toReturn: to_return,
      status: BetStatus.PENDING,
      metadata: runner_name_2 ? { runner_name_2 } : undefined,
    });
    debug.bet_id = insertResult.insertId;

    // 6. UPDATE EXPOSURE
    await this.updateExposureBalance(
      userId,
      required_amount,
      settlement_id,
      gtype,
    );

    // 7. DEBIT WALLET
    if (required_amount > 0) {
      await this.adjustWalletBalance(
        userId,
        required_amount,
        'debit',
        `Bet placed for ${bet_name}`,
      );
      debug.wallet_debited = required_amount;
    }

    // 8. EXTERNAL API CALL IF NECESSARY
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

    return { success: true, debug, avl_limit };
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
          data: { userId, balance: user.balance ?? 0 },
        });
      }

      if (type === 'debit' && wallet.balance < amount) {
        throw new HttpException(
          {
            success: false,
            error: 'Insufficient wallet balance.',
            code: 'INSUFFICIENT_FUNDS',
          },
          400,
        );
      }

      const delta = type === 'debit' ? -amount : amount;

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: {
            increment: delta,
          },
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          balance: {
            increment: delta,
          },
        },
      });

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
