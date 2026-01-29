import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, WorkerOptions } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MatchOddsExposureService } from './matchodds-exposure.service';
import { FancyExposureService } from './fancy-exposure.service';
import { BookmakerExposureService } from './bookmaker-exposure.service';
import { BetStatus, Bet, MatchStatus, TransactionType } from '@prisma/client';
import { RedisService } from '../common/redis/redis.service';
import {
  calculateMatchOddsPosition,
  calculateBookmakerPosition,
  calculateFancyPosition,
} from '../positions/position.service';

/**
 * ✅ PERFORMANCE: Bet Processing Worker
 * 
 * Processes heavy calculations in background:
 * - Fancy delta calculation
 * - Match Odds offset calculation
 * - Bookmaker exposure logic
 * - Cross-market exposure recalculation
 * - Final wallet updates
 * - Bet status: ACCEPTED → CONFIRMED
 */
@Injectable()
export class BetProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BetProcessingWorker.name);
  private worker: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchOddsExposureService: MatchOddsExposureService,
    private readonly fancyExposureService: FancyExposureService,
    private readonly bookmakerExposureService: BookmakerExposureService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    // ✅ Gracefully handle Redis connection failures
    try {
      this.worker = new Worker(
        'bet-processing',
        async (job) => {
        // ✅ Handle different job types
        if (job.name === 'calculate-positions') {
          return await this.handlePositionCalculation(job);
        } else if (job.name === 'process-bet-exposure') {
          return await this.handleBetExposureProcessing(job);
        } else if (job.name === 'process-bet') {
          return await this.handleBetProcessing(job);
        } else {
          throw new Error(`Unknown job type: ${job.name}`);
        }
      },
      {
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          maxRetriesPerRequest: null, // Disable retries to reduce spam
          enableReadyCheck: false, // Don't wait for ready check
          lazyConnect: true, // Connect on demand
          retryStrategy: () => null, // Stop retrying immediately
          enableOfflineQueue: false, // Don't queue commands when offline
        },
        concurrency: 5, // Process 5 bets concurrently
      },
    );

      this.worker.on('completed', (job) => {
        this.logger.debug(`Bet processing job ${job.id} completed`);
      });

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `Bet processing job ${job?.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Handle connection errors gracefully (reduce log spam)
      let connectionErrorLogged = false;
      this.worker.on('error', (err) => {
        const errorCode = (err as any)?.code || 'UNKNOWN';
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        // Filter out common connection errors to reduce log spam
        const isConnectionError = 
          errorCode === 'ECONNREFUSED' || 
          errorMessage.includes('Connection is closed') ||
          errorMessage.includes('ECONNREFUSED');
        
        if (isConnectionError && !connectionErrorLogged) {
          this.logger.warn(
            'Redis not available for bet processing worker. ' +
            'Background processing will be unavailable until Redis is started. ' +
            'Bets will still be accepted (fast path), but heavy calculations will be delayed.',
          );
          connectionErrorLogged = true;
        } else if (!isConnectionError) {
          // Only log non-connection errors
          this.logger.error(`Bet processing worker error: ${errorMessage}`);
        }
        // Silently ignore connection errors after first warning
      });

      this.logger.log('Bet Processing Worker started');
    } catch (error) {
      this.logger.error(
        `Failed to start bet processing worker: ${error instanceof Error ? error.message : String(error)}. ` +
        'Background processing will be unavailable. Bets will still be accepted (fast path).',
      );
      // Don't throw - allow app to continue without background processing
      this.worker = null as any;
    }
  }

  /**
   * ✅ PERFORMANCE: Handle bet exposure processing in background
   * Calculates real exposure (with offsets, double fancy, etc.) and adjusts wallet
   * Uses EXISTING exposure calculation logic - no changes to formulas
   */
  private async handleBetExposureProcessing(job: any): Promise<any> {
    const {
      betId,
      userId,
      walletId,
      marketId,
      matchId,
      eventId,
      rawGtype,
      betType,
      betName,
      marketName,
      marketType,
      betValue,
      betRate,
      selectionId,
      winAmount: rawWinAmount,
      lossAmount: rawLossAmount,
      maxPossibleLoss,
    } = job.data;

    this.logger.log(`Processing bet exposure for ${betId} in background`);

    try {
      // ✅ IDEMPOTENCY: Check bet status (must be PENDING)
      const bet = await this.prisma.bet.findUnique({
        where: { id: betId },
        select: { status: true },
      });

      if (!bet) {
        throw new Error(`Bet ${betId} not found`);
      }

      if (bet.status !== BetStatus.PENDING) {
        this.logger.warn(`Bet ${betId} is not in PENDING status (current: ${bet.status}), skipping`);
        return { skipped: true, reason: 'not_pending' };
      }

      // ✅ WORKER: Resolve market type (moved from API)
      const normalizedGtype = (rawGtype || '').toLowerCase();
      const normalizedMarketName = (marketName || '').toLowerCase();
      let actualMarketType = normalizedGtype;
      
      // Handle "match1", "match2", etc. as bookmaker
      if (normalizedGtype.startsWith('match') && normalizedGtype !== 'match' && normalizedGtype !== 'matchodds') {
        actualMarketType = 'bookmaker';
      }
      // Fallback: Check market_name if gtype is ambiguous
      else if (!normalizedGtype || normalizedGtype === '') {
        if (normalizedMarketName.includes('bookmaker')) {
          actualMarketType = 'bookmaker';
        } else if (normalizedMarketName.includes('fancy')) {
          actualMarketType = 'fancy';
        } else if (normalizedMarketName.includes('match odds') || normalizedMarketName.includes('matchodds')) {
          actualMarketType = 'matchodds';
        }
      }

      // Handle "match" as alias for "matchodds"
      if (actualMarketType === 'matchodds' || actualMarketType === 'match') {
        actualMarketType = 'matchodds';
      }

      // Set resolved gtype for bet
      let resolvedGtype = 'matchodds';
      if (actualMarketType === 'fancy') {
        resolvedGtype = 'fancy';
      } else if (actualMarketType === 'bookmaker') {
        resolvedGtype = 'bookmaker';
      }

      // ✅ WORKER: Calculate winAmount, lossAmount, toReturn (moved from API)
      const normalizedBetType = (betType || '').toUpperCase();
      const isBackBet = normalizedBetType === 'BACK';
      const isLayBet = normalizedBetType === 'LAY' || normalizedBetType === 'NO';
      
      let calculatedWinAmount = Number(rawWinAmount) || 0;
      if (betValue > 0 && betRate > 0) {
        if (isBackBet) {
          calculatedWinAmount = calculatedWinAmount || betValue * betRate;
        } else if (isLayBet) {
          calculatedWinAmount = calculatedWinAmount || betValue;
        }
      }

      // Calculate lossAmount based on resolved market type
      let calculatedLossAmount = 0;
      if (resolvedGtype === 'fancy') {
        if (isLayBet) {
          // Fancy LAY: Use raw loss_amount if provided, otherwise calculate
          const payloadLossAmount = Number(rawLossAmount) || 0;
          calculatedLossAmount = payloadLossAmount > 0 
            ? payloadLossAmount 
            : betValue; // Fancy liability = stake
        } else {
          // Fancy YES/BACK: liability = stake
          calculatedLossAmount = betValue;
        }
      } else if (resolvedGtype === 'bookmaker') {
        // Bookmaker: LAY = (odds - 1) * stake, BACK = stake
        calculatedLossAmount = isLayBet && betRate > 1
          ? (betRate - 1) * betValue
          : betValue;
      } else if (resolvedGtype === 'matchodds') {
        // Match Odds: BACK = stake, LAY = (odds - 1) * stake
        calculatedLossAmount = isBackBet
          ? betValue
          : (betRate - 1) * betValue;
      }

      const calculatedToReturn = calculatedWinAmount + calculatedLossAmount;

      // ✅ Upsert match (non-critical, moved from fast path)
      await this.prisma.match.upsert({
        where: { id: matchId },
        update: {
          ...(eventId && { eventId }),
          ...(marketId && { marketId }),
        },
        create: {
          id: matchId,
          homeTeam: betName ?? 'Unknown',
          awayTeam: marketName ?? 'Unknown',
          startTime: new Date(),
          status: MatchStatus.LIVE,
          ...(eventId && { eventId }),
          ...(marketId && { marketId }),
        },
      });

      // ✅ Load all PENDING bets for same user + market (EXISTING LOGIC)
      const allPendingBets = await this.prisma.bet.findMany({
        where: {
          userId,
          status: BetStatus.PENDING,
          marketId, // 🔥 CRITICAL: Filter by marketId to isolate exposure per market
        },
        select: {
          id: true, // Needed to filter out current bet
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

      // ✅ Create new bet object in memory (EXISTING LOGIC) - use resolved gtype and calculated fields
      const newBet = {
        gtype: resolvedGtype,
        marketId,
        eventId: eventId || null,
        selectionId,
        betType,
        betValue,
        amount: betValue,
        betRate,
        odds: betRate,
        winAmount: calculatedWinAmount,
        lossAmount: calculatedLossAmount,
      };

      // ✅ Calculate exposure deltas using EXISTING LOGIC (unchanged)
      let matchOddsDelta = 0;
      let fancyDelta = 0;
      let bookmakerDelta = 0;

      if (marketType === 'matchodds' || marketType === 'match') {
        // ✅ Match Odds exposure delta (EXISTING LOGIC - unchanged)
        matchOddsDelta =
          this.matchOddsExposureService.calculateMatchOddsExposureDelta(
            allPendingBets.filter((b) => b.id !== betId), // Exclude current bet if already in list
            newBet,
          );
      } else if (marketType === 'fancy') {
        // ✅ FANCY DELTA using Maximum Possible Loss model (EXISTING LOGIC - unchanged)
        const fancyResult = this.fancyExposureService.calculateFancyGroupDeltaSafe(
          allPendingBets.filter((b) => b.id !== betId),
          newBet,
        );
        fancyDelta = fancyResult.delta;
      } else if (marketType === 'bookmaker') {
        // ✅ BOOKMAKER DELTA (EXISTING LOGIC - unchanged)
        const allBetsWithNewBet = [...allPendingBets.filter((b) => b.id !== betId), newBet];
        bookmakerDelta = this.bookmakerExposureService.calculateBookmakerExposureDelta(
          allPendingBets.filter((b) => b.id !== betId),
          allBetsWithNewBet,
          marketId,
        );
      }

      // ✅ FINAL exposureDelta = sum of individual deltas (EXISTING LOGIC)
      const realExposureDelta = matchOddsDelta + fancyDelta + bookmakerDelta;

      // ✅ Update wallet: Compare locked exposure vs real exposure
      await this.prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({
          where: { userId },
        });

        if (!wallet) {
          throw new Error(`Wallet not found for user ${userId}`);
        }

        const currentBalance = Number(wallet.balance) || 0;
        const currentLiability = Number(wallet.liability) || 0;
        const currentLockedExposure = Number(wallet.lockedExposure) || 0;

        // ✅ Calculate adjustment: difference between locked exposure and real exposure
        // Fast path already did: balance -= maxPossibleLoss, lockedExposure += maxPossibleLoss
        // Now we need to:
        // 1. Release maxPossibleLoss from lockedExposure (this bet's lock)
        // 2. Apply real exposureDelta to liability
        // 3. Adjust balance: refund excess if real < max, or lock more if real > max (shouldn't happen)
        // 4. Lock realExposureDelta in lockedExposure (if positive)
        const balanceAdjustment = maxPossibleLoss - realExposureDelta; // Positive = refund excess
        const finalBalance = currentBalance + balanceAdjustment; // Refund excess or lock more
        const finalLiability = currentLiability + realExposureDelta; // Apply real exposure
        const finalLockedExposure = currentLockedExposure - maxPossibleLoss + (realExposureDelta > 0 ? realExposureDelta : 0);

        await tx.wallet.update({
          where: { userId },
          data: {
            balance: finalBalance,
            liability: finalLiability,
            lockedExposure: finalLockedExposure,
          },
        });

        // ✅ Update bet with calculated fields (winAmount, lossAmount, toReturn, resolved gtype)
        await tx.bet.update({
          where: { id: betId },
          data: {
            winAmount: calculatedWinAmount,
            lossAmount: calculatedLossAmount,
            toReturn: calculatedToReturn,
            gtype: resolvedGtype, // Update with resolved gtype
          },
        });

        // ✅ Create transaction log (moved from fast path)
        await tx.transaction.create({
          data: {
            walletId: walletId,
            amount: Math.abs(realExposureDelta),
            type: realExposureDelta > 0 ? TransactionType.BET_PLACED : TransactionType.REFUND,
            description: `${actualMarketType.charAt(0).toUpperCase() + actualMarketType.slice(1)} bet processed: ${betName} (${betType}) - Stake: ${betValue}, Real Exposure: ${realExposureDelta}, Adjustment: ${balanceAdjustment}`,
          },
        });

        this.logger.log(
          `Bet ${betId} exposure processed. ` +
          `Locked: ${maxPossibleLoss}, Real: ${realExposureDelta}, Adjustment: ${balanceAdjustment}. ` +
          `Deltas: MO=${matchOddsDelta}, Fancy=${fancyDelta}, BM=${bookmakerDelta}`,
        );
      });

      // ✅ Invalidate caches in background
      this.redisService.invalidateUserPositions(userId).catch(() => {});
      this.redisService.invalidateUserExposure(userId).catch(() => {});

      return { success: true, realExposureDelta, maxPossibleLoss };
    } catch (error) {
      // Log error but don't fail - wallet is already protected by lockedExposure
      this.logger.error(
        `Failed to process bet exposure for ${betId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * ✅ PERFORMANCE: Handle position calculation in background
   * Position calculation is read-only and doesn't affect bet placement
   */
  private async handlePositionCalculation(job: any): Promise<any> {
    const { betId, userId, marketId, rawGtype } = job.data;

    this.logger.debug(`Calculating positions for bet ${betId} in background`);

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

      // ✅ Resolve market type from rawGtype (same logic as exposure processing)
      const normalizedGtype = (rawGtype || '').toLowerCase();
      let resolvedMarketType = normalizedGtype;
      if (normalizedGtype.startsWith('match') && normalizedGtype !== 'match' && normalizedGtype !== 'matchodds') {
        resolvedMarketType = 'bookmaker';
      } else if (normalizedGtype === 'matchodds' || normalizedGtype === 'match') {
        resolvedMarketType = 'matchodds';
      }

      // ✅ MARKET ISOLATION: Use market-specific position functions
      if (resolvedMarketType === 'matchodds' || resolvedMarketType === 'match') {
        // ⚠️ TODO: Get marketSelections from market source (DB/API), not from bets
        // For now, derive minimal set from bets as fallback
        const marketSelections = Array.from(
          new Set(
            pendingBets
              .map((bet) => bet.selectionId)
              .filter((id): id is number => id !== null && id !== undefined)
              .map((id) => String(id))
          )
        );
        
        if (marketSelections.length > 0) {
          const matchOddsPosition = calculateMatchOddsPosition(
            pendingBets as Bet[],
            marketId,
            marketSelections,
          );
          if (matchOddsPosition) {
            const positions: Record<string, { win: number; lose: number }> = {};
            // Convert to backward-compatible format (net -> win/lose)
            for (const [selectionId, runner] of Object.entries(matchOddsPosition.runners)) {
              const net = runner.net;
              positions[selectionId] = {
                win: net > 0 ? net : 0,  // Profit if wins (clamped for backward compat)
                lose: net < 0 ? Math.abs(net) : 0,  // Loss if loses (clamped for backward compat)
              };
            }
            this.logger.debug(
              `Match Odds position calculated: ${JSON.stringify(positions)}`,
            );
          }
        }
      } else if (resolvedMarketType === 'bookmaker') {
        // ⚠️ TODO: Get marketSelections from market source (DB/API), not from bets
        // For now, derive minimal set from bets as fallback
        const marketSelections = Array.from(
          new Set(
            pendingBets
              .map((bet) => bet.selectionId)
              .filter((id): id is number => id !== null && id !== undefined)
              .map((id) => String(id))
          )
        );
        
        if (marketSelections.length > 0) {
          const bookmakerPosition = calculateBookmakerPosition(
            pendingBets as Bet[],
            marketId,
            marketSelections,
          );
          if (bookmakerPosition) {
            const positions: Record<string, { win: number; lose: number }> = {};
            // Convert to backward-compatible format (net -> win/lose)
            for (const [selectionId, runner] of Object.entries(bookmakerPosition.runners)) {
              const net = runner.net;
              positions[selectionId] = {
                win: net > 0 ? net : 0,  // Profit if wins (clamped for backward compat)
                lose: net < 0 ? Math.abs(net) : 0,  // Loss if loses (clamped for backward compat)
              };
            }
            this.logger.debug(
              `Bookmaker position calculated: ${JSON.stringify(positions)}`,
            );
          }
        }
      } else if (resolvedMarketType === 'fancy') {
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
            `Position calculation: Skipped for market type ${resolvedMarketType}`,
          );
        }

      // ✅ Invalidate caches in background
      this.redisService.invalidateUserPositions(userId).catch(() => {});

      return { success: true };
    } catch (positionError) {
      // Log error but don't fail - position is UI-only and doesn't affect bet placement
      this.logger.warn(
        `Failed to calculate positions for user ${userId}, market ${marketId}:`,
        positionError instanceof Error ? positionError.message : String(positionError),
        positionError instanceof Error ? positionError.stack : undefined,
      );
      return { success: false, error: positionError instanceof Error ? positionError.message : String(positionError) };
    }
  }

  /**
   * ✅ Handle bet processing (existing logic for ACCEPTED -> CONFIRMED)
   */
  private async handleBetProcessing(job: any): Promise<any> {
        const { betId, userId, marketId, eventId, marketType, gtype, betType, betValue, betRate, selectionId, winAmount, lossAmount } = job.data;

        this.logger.log(`Processing bet ${betId} in background`);

        // ✅ IDEMPOTENCY: Check bet status
        const bet = await this.prisma.bet.findUnique({
          where: { id: betId },
          select: { status: true },
        });

        if (!bet) {
          throw new Error(`Bet ${betId} not found`);
        }

        if (bet.status !== BetStatus.ACCEPTED) {
          this.logger.warn(`Bet ${betId} is not in ACCEPTED status (current: ${bet.status}), skipping`);
          return { skipped: true, reason: 'not_accepted' };
        }

        // ✅ Load all pending/confirmed bets for same marketId (for exposure calculation)
        const allPendingBets = await this.prisma.bet.findMany({
          where: {
            userId,
            status: { in: [BetStatus.PENDING, BetStatus.ACCEPTED, BetStatus.CONFIRMED] },
            marketId,
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
            // @ts-ignore
            isRangeConsumed: true,
          } as any,
        });

        // ✅ Create new bet object in memory
        const newBet = {
          gtype,
          marketId,
          eventId: eventId || null,
          selectionId,
          betType,
          betValue,
          amount: betValue,
          betRate,
          odds: betRate,
          winAmount,
          lossAmount,
        };

        // ✅ Calculate exposure deltas using EXISTING logic (unchanged)
        let matchOddsDelta = 0;
        let fancyDelta = 0;
        let bookmakerDelta = 0;

        if (marketType === 'matchodds' || marketType === 'match') {
          matchOddsDelta = this.matchOddsExposureService.calculateMatchOddsExposureDelta(
            allPendingBets.filter((b) => b.id !== betId), // Exclude current bet
            newBet,
          );
        } else if (marketType === 'fancy') {
          const fancyResult = this.fancyExposureService.calculateFancyGroupDeltaSafe(
            allPendingBets.filter((b) => b.id !== betId),
            newBet,
          );
          fancyDelta = fancyResult.delta;
        } else if (marketType === 'bookmaker') {
          const allBetsWithNewBet = [...allPendingBets.filter((b) => b.id !== betId), newBet];
          bookmakerDelta = this.bookmakerExposureService.calculateBookmakerExposureDelta(
            allPendingBets.filter((b) => b.id !== betId),
            allBetsWithNewBet,
            marketId,
          );
        }

        const exposureDelta = matchOddsDelta + fancyDelta + bookmakerDelta;

        // ✅ Update wallet: Release lockedExposure, apply final exposure
        await this.prisma.$transaction(async (tx) => {
          const wallet = await tx.wallet.findUnique({
            where: { userId },
          });

          if (!wallet) {
            throw new Error(`Wallet not found for user ${userId}`);
          }

          const currentBalance = Number(wallet.balance) || 0;
          const currentLiability = Number(wallet.liability) || 0;
          const currentLockedExposure = Number(wallet.lockedExposure) || 0;

          // ✅ Calculate requiredExposure that was locked in fast path
          let requiredExposure = 0;
          if (betType?.toUpperCase() === 'BACK' || betType?.toUpperCase() === 'YES') {
            requiredExposure = betValue;
          } else if (betType?.toUpperCase() === 'LAY' || betType?.toUpperCase() === 'NO') {
            requiredExposure = (betRate - 1) * betValue;
          } else {
            requiredExposure = betValue;
          }

          // ✅ Calculate adjustment: difference between locked exposure and actual exposure
          // lockedExposure was already deducted from balance in fast path
          // Now we need to:
          // 1. Release lockedExposure for this bet (add back to balance)
          // 2. Apply actual exposureDelta (deduct from balance, add to liability)
          // 3. Adjust lockedExposure (subtract this bet's requiredExposure)
          const balanceAdjustment = requiredExposure - exposureDelta; // Positive = release, Negative = lock more
          const finalBalance = currentBalance + balanceAdjustment;
          const finalLiability = currentLiability + exposureDelta;
          const finalLockedExposure = currentLockedExposure - requiredExposure; // Release this bet's locked exposure

          await tx.wallet.update({
            where: { userId },
            data: {
              balance: finalBalance,
              liability: finalLiability,
              lockedExposure: finalLockedExposure,
            },
          });

          // ✅ Update bet status: ACCEPTED → CONFIRMED
          await tx.bet.update({
            where: { id: betId },
            data: {
              status: BetStatus.CONFIRMED,
            },
          });

          this.logger.log(
            `Bet ${betId} confirmed. Exposure: MO=${matchOddsDelta}, Fancy=${fancyDelta}, BM=${bookmakerDelta}, Total=${exposureDelta}`,
          );
        });

        // ✅ Invalidate caches in background
        this.redisService.invalidateUserPositions(userId).catch(() => {});
        this.redisService.invalidateUserExposure(userId).catch(() => {});

        return { success: true, exposureDelta };
  }

  onModuleDestroy() {
    if (this.worker) {
      return this.worker.close();
    }
    return Promise.resolve();
  }
}

