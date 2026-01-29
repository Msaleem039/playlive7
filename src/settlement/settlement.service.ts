import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaClient, BetStatus, MarketType, TransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AggregatorService } from '../cricketid/aggregator.service';
import { PnlService } from './pnl.service';
import { HierarchyPnlService } from './hierarchy-pnl.service';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  // Cache for expired/invalid eventIds to avoid repeated API calls
  private readonly expiredEventIdsCache = new Set<string>();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private readonly cacheTimestamps = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregatorService: AggregatorService,
    private readonly pnlService: PnlService,
    private readonly hierarchyPnlService: HierarchyPnlService,
  ) {
    // Clean expired cache entries every 5 minutes
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
  }

  private cleanExpiredCache() {
    const now = Date.now();
    for (const [eventId, timestamp] of this.cacheTimestamps.entries()) {
      if (now - timestamp > this.CACHE_TTL) {
        this.expiredEventIdsCache.delete(eventId);
        this.cacheTimestamps.delete(eventId);
      }
    }
  }

  private isEventIdExpired(eventId: string): boolean {
    // Check if eventId is in cache and still valid
    const timestamp = this.cacheTimestamps.get(eventId);
    if (timestamp && Date.now() - timestamp < this.CACHE_TTL) {
      return this.expiredEventIdsCache.has(eventId);
    }
    return false;
  }

  private markEventIdAsExpired(eventId: string) {
    this.expiredEventIdsCache.add(eventId);
    this.cacheTimestamps.set(eventId, Date.now());
  }

 
  // 🔐 STRICT: Use fixed decimal precision (2 decimal places) to avoid floating point drift


  private layLiability(stake: number, odds: number): number {
    const liability = (odds - 1) * stake;
    return Math.round(liability * 100) / 100;
  }



  /**
   * ✅ BOOKMAKER-SPECIFIC HELPER FUNCTIONS
   * 
   * 🔐 CRITICAL: Bookmaker uses PERCENTAGE-BASED odds, not decimal odds.
   * 
   * BACK profit = (stake * odds) / 100
   * LAY liability = (stake * odds) / 100
   * LAY profit = stake
   */
  private bookmakerBackProfit(stake: number, odds: number): number {
    // ✅ CORRECT: Bookmaker BACK profit uses percentage odds
    const profit = (stake * odds) / 100;
    return Math.round(profit * 100) / 100;
  }

  private bookmakerLayLiability(stake: number, odds: number): number {
    // ✅ CORRECT: Bookmaker LAY liability uses percentage odds
    const liability = (stake * odds) / 100;
    return Math.round(liability * 100) / 100;
  }

  /**
   * ✅ NORMAL FANCY EVALUATOR (SINGLE BET LEVEL)
   * 
   * Evaluates normal fancy bets only (not RANGE fancy).
   * Each bet is evaluated independently based on actual runs vs line.
   * 
   * ⚠️ GROUP / DOUBLE / GOLA = COMPLETELY GONE
   * 
   * @param bets - Array of bets to evaluate
   * @param actualRuns - Actual runs scored
   * @returns Map of betId -> isWin (true if bet wins, false if loses)
   */
  private evaluateFancySingle(
    bets: Array<{
      id: string;
      betType: string | null;
      betRate: number | null;
      odds: number | null;
    }>,
    actualRuns: number,
  ): Map<string, boolean> {
    const result = new Map<string, boolean>();

    for (const bet of bets) {
        const line = bet.betRate ?? bet.odds ?? 0;
        const betType = bet.betType?.toUpperCase();

        const isYes = betType === 'YES' || betType === 'BACK';
        const isNo = betType === 'NO' || betType === 'LAY';

        let isWin = false;

      if (isNo && actualRuns < line) isWin = true;
      if (isYes && actualRuns >= line) isWin = true;

        result.set(bet.id, isWin);
    }

    return result;
  }

  async settleFancyManual(
    eventId: string,
    selectionId: string,
    decisionRun: number | null,
    isCancel: boolean,
    marketId: string | null,
    adminId: string,
    betIds?: string[], // Optional: settle only specific bets
  ) {
    const settlementId = `CRICKET:FANCY:${eventId}:${selectionId}`;

    // Find bets with new format first
    let bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
        eventId: eventId,
        selectionId: Number(selectionId),
        // Filter by betIds if provided
        ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
      },
    });

    // If no bets found with new format, try to find bets with old format (legacy: ${match_id}_${selection_id})
    // For fancy, the old format was ${match_id}_${selection_id}, so we can match by eventId and selectionId
    if (bets.length === 0) {
      // Try finding bets by eventId and selectionId
      bets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          selectionId: Number(selectionId),
          status: BetStatus.PENDING,
          // Filter by betIds if provided
          ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
          // Fancy bets typically have gtype containing "fancy"
          OR: [
            { gtype: { contains: 'fancy', mode: 'insensitive' } },
            { marketType: { contains: 'fancy', mode: 'insensitive' } },
          ],
        },
      });

      // If we found bets with old format, update their settlementId to the new format
      if (bets.length > 0) {
        this.logger.log(
          `Found ${bets.length} bets with legacy format for eventId ${eventId}, selectionId ${selectionId}. Updating settlementId to new format.`,
        );
        
        // Update settlementId for all found bets
        await this.prisma.bet.updateMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
          data: {
            settlementId: settlementId,
          },
        });

        // Refresh bets to get updated settlementId
        bets = await this.prisma.bet.findMany({
          where: {
            id: { in: bets.map((b) => b.id) },
          },
        });
      }
    }

    if (bets.length === 0) {
      // Check if settlement exists and all bets are already settled
      // @ts-ignore - settlement property exists after Prisma client regeneration
      const existingSettlement = await this.prisma.settlement.findUnique({
        where: { settlementId },
      });

      if (existingSettlement && !existingSettlement.isRollback) {
        // Check if there are any settled bets for this settlement
        const settledBets = await this.prisma.bet.findMany({
          where: {
            settlementId,
            status: {
              in: [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED],
            },
          },
        });

        if (settledBets.length > 0) {
          throw new BadRequestException(
            `Settlement ${settlementId} already exists and all bets are settled. ` +
            `It was settled by ${existingSettlement.settledBy} on ${existingSettlement.createdAt.toISOString()}. ` +
            `To re-settle, please rollback the existing settlement first using POST /admin/settlement/rollback`,
          );
        }
      }

      return { success: true, message: 'No pending bets to settle' };
    }

    // Check if settlement already exists (but allow re-settlement if there are pending bets)
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const existingSettlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (existingSettlement && !existingSettlement.isRollback) {
      // Allow re-settlement if there are pending bets (some bets might have been missed)
      this.logger.warn(
        `Settlement ${settlementId} already exists, but ${bets.length} pending bets found. ` +
        `Proceeding with re-settlement. Original settlement by ${existingSettlement.settledBy} on ${existingSettlement.createdAt.toISOString()}`,
      );
    }

    // Create settlement record FIRST (or update if exists)
    // @ts-ignore - settlement property exists after Prisma client regeneration
    await this.prisma.settlement.upsert({
      where: { settlementId },
      update: {
        isRollback: false,
        settledBy: adminId,
        winnerId: isCancel ? null : (decisionRun?.toString() || null), // Update winner in case it changed
      },
      create: {
        settlementId,
        eventId,
        marketType: MarketType.FANCY,
        marketId: marketId || null,
        winnerId: isCancel ? null : (decisionRun?.toString() || null),
        settledBy: adminId,
      },
    });

    if (decisionRun === null && !isCancel) {
      throw new BadRequestException(
        'Either decisionRun or isCancel must be provided',
      );
    }

    const actualRuns = decisionRun ?? 0;
    const affectedUserIds = new Set<string>();

    // ✅ CLEAN FANCY SETTLEMENT ENGINE
    await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Group by user
        const betsByUser = new Map<string, typeof bets>();
        for (const bet of bets) {
          if (!betsByUser.has(bet.userId)) {
            betsByUser.set(bet.userId, []);
          }
          betsByUser.get(bet.userId)!.push(bet);
        }

        // 2️⃣ Settle user by user
        for (const [userId, userBets] of betsByUser.entries()) {
          const wallet = await tx.wallet.findUnique({
            where: { userId },
          });

          if (!wallet) {
            this.logger.warn(`Wallet not found for user ${userId}`);
            continue;
          }

          let balanceDelta = 0;
          let liabilityDelta = 0;

          // ✅ SYSTEM-LEVEL RANGE FANCY DETECTION
          // A settlement group is treated as RANGE FANCY when:
          // - Multiple bets share the same settlementId (they already do in this function)
          // - There is at least one BACK and one LAY bet in that group
          const hasBack = userBets.some(
            (b) => (b.betType?.toUpperCase() === 'BACK' || b.betType?.toUpperCase() === 'YES'),
          );
          const hasLay = userBets.some(
            (b) => (b.betType?.toUpperCase() === 'LAY' || b.betType?.toUpperCase() === 'NO'),
          );
          const isRangeStyleGroup = hasBack && hasLay && userBets.length > 1;

          // ✅ Evaluate normal fancy bets only (for non-range-style groups)
          const winResultMap = isCancel
            ? new Map<string, boolean>() // Cancel doesn't need evaluation
            : this.evaluateFancySingle(userBets, actualRuns);

          // ✅ RANGE-STYLE GROUP SETTLEMENT (if detected)
          if (isRangeStyleGroup) {
            if (isCancel) {
              // CANCEL: Refund all locked liabilities for range-style group
              let totalLiabilityRelease = 0;
            for (const bet of userBets) {
                const betType = bet.betType?.toUpperCase();
                const lossAmount = bet.lossAmount ?? bet.amount ?? 0;
                const liabilityAmount =
                  betType === 'LAY' || betType === 'NO' ? lossAmount : bet.amount ?? 0;

                totalLiabilityRelease += liabilityAmount;

                await tx.bet.update({
                  where: { id: bet.id },
                  data: {
                    status: BetStatus.CANCELLED,
                    // @ts-ignore
                    pnl: 0,
                    settledAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
              }

              liabilityDelta -= totalLiabilityRelease;
              balanceDelta += totalLiabilityRelease; // Refund all locked amounts
            } else {
              // Calculate net profit across all bets in the group
              let netProfit = 0;
              let totalLiabilityRelease = 0;

              for (const bet of userBets) {
                const betType = bet.betType?.toUpperCase();
                const winAmount = bet.winAmount ?? bet.amount ?? 0;
                const lossAmount = bet.lossAmount ?? bet.amount ?? 0;
                const liabilityAmount =
                  betType === 'LAY' || betType === 'NO' ? lossAmount : bet.amount ?? 0;

                // Always release liability for each bet
                totalLiabilityRelease += liabilityAmount;

                // Determine win/loss for this bet
                const isWin = winResultMap.get(bet.id) ?? false;

                if (isWin) {
                  // Winning bet contributes profit
                  netProfit += winAmount;
                } else {
                  // Losing bet contributes negative (loss)
                  netProfit -= lossAmount;
                }

                // Mark bet as settled
                await tx.bet.update({
                  where: { id: bet.id },
                  data: {
                    status: isWin ? BetStatus.WON : BetStatus.LOST,
                    // @ts-ignore
                    pnl: isWin ? winAmount : -lossAmount,
                    settledAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
                  }
                  
              // Release all liabilities
              liabilityDelta -= totalLiabilityRelease;

              // ✅ RANGE-STYLE SETTLEMENT RULE:
              // If net profit > 0: credit wallet ONCE per settlementId
              // If net profit <= 0: no wallet balance change
              if (netProfit > 0) {
                balanceDelta += netProfit;
              }
              // If netProfit <= 0, balanceDelta remains 0 (no wallet change)
            }

            // Skip per-bet processing for range-style groups
            // Wallet update will happen once per user below
          } else {
            // ✅ NORMAL FANCY SETTLEMENT (per-bet processing)
          // 3️⃣ Process each bet
          for (const bet of userBets) {
            // ✅ CORRECT FANCY FIELD MAPPING
            const stake = bet.amount ?? 0; // stake amount
            const betType = bet.betType?.toUpperCase(); // BACK / LAY or YES / NO
              const winAmount = bet.winAmount ?? stake; // profit amount when bet wins
            const lossAmount = bet.lossAmount ?? stake; // loss amount when bet loses
            
            // Determine liability amount: BACK uses stake, LAY uses lossAmount
            const liabilityAmount = (betType === 'LAY' || betType === 'NO') ? lossAmount : stake;

              // 🔁 CANCEL: Refund the amount that was deducted (liabilityAmount)
            if (isCancel) {
              liabilityDelta -= liabilityAmount; // release the liability that was locked
              balanceDelta += liabilityAmount; // refund the amount that was deducted

              await tx.bet.update({
                where: { id: bet.id },
                data: {
                  status: BetStatus.CANCELLED,
                  // @ts-ignore
                  pnl: 0,
                  settledAt: new Date(),
                  updatedAt: new Date(),
                },
              });
              continue;
            }

              /* =========================================
                 ✅ NORMAL FANCY — EXISTING LOGIC
                 ========================================= */

            const isWin = winResultMap.get(bet.id) ?? false;
            
              // Always release liability
            liabilityDelta -= liabilityAmount;

            if (isWin) {
                    if (betType === 'BACK' || betType === 'YES') {
                  // BACK/YES WIN: return stake + profit
                  balanceDelta += stake + winAmount;

                  //  balanceDelta += winAmount;
                    } else {
                  // LAY/NO WIN: return locked stake (lossAmount) + profit
                  balanceDelta += lossAmount + winAmount;
              }

              await tx.bet.update({
                where: { id: bet.id },
                data: {
                  status: BetStatus.WON,
                  // @ts-ignore
                  pnl: winAmount, // Reporting: profit = winAmount
                  settledAt: new Date(),
                  updatedAt: new Date(),
                },
              });
            } else {
              await tx.bet.update({
                where: { id: bet.id },
                data: {
                  status: BetStatus.LOST,
                  // @ts-ignore
                  pnl: -lossAmount, // Reporting: loss amount
                  settledAt: new Date(),
                  updatedAt: new Date(),
                },
              });
              // 🔐 CRITICAL: NO balance change for loss
              // ASSUMPTION: At bet placement, we MUST have done:
              //   BACK: wallet.balance -= stake, wallet.liability += stake
              //   LAY: wallet.balance -= lossAmount, wallet.liability += lossAmount
              // If this assumption is false, fancy wallet math is broken.
              // NOTE: PNL = -lossAmount for reporting, but walletImpact = 0
              // The deducted amount (stake for BACK, lossAmount for LAY) was already locked at placement
              // Reporting layer should expose: { pnl: -lossAmount, walletImpact: 0, liabilityReleased: liabilityAmount }
              }
            }
          }

          // 4️⃣ Apply wallet changes ONCE per user
          if (balanceDelta !== 0 || liabilityDelta !== 0) {
            await tx.wallet.update({
              where: { userId },
              data: {
                balance: wallet.balance + balanceDelta,
                liability: wallet.liability + liabilityDelta,
              },
            });

            // Create transaction record
            if (balanceDelta > 0) {
              await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount: balanceDelta,
                  type: isCancel ? TransactionType.REFUND : TransactionType.BET_WON,
                  description: isCancel
                    ? `Fancy Settlement CANCEL: Refunded ${balanceDelta} - ${settlementId}`
                    : `Fancy Settlement: Profit credited ${balanceDelta} - ${settlementId}`,
                },
              });
            }

            affectedUserIds.add(userId);
          }
        }
      },
      {
        maxWait: 15000,
        timeout: 30000,
      },
    );

    // Recalculate P/L for all affected users (Fancy-specific)
    await this.recalculatePnLForUsersFancy(affectedUserIds, eventId);

    return { success: true, message: 'Fancy bets settled successfully' };
  }

  /**
   * ✅ MATCH ODDS EXPOSURE CALCULATION (MARKET-SPECIFIC)
   * 
   * Calculates net exposure for Match Odds market ONLY
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
    const bets = await tx.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
        gtype: { in: ['matchodds', 'match'] },
        marketId,
      },
      select: {
        selectionId: true,
        betType: true,
        betValue: true,
        amount: true,
        betRate: true,
        odds: true,
      },
    });
  
    const exposureBySelection = new Map<number, number>();
  
    for (const bet of bets) {
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      const selectionId = Number(bet.selectionId);
      if (isNaN(selectionId)) continue;
  
      let loss = 0;
  
      if (bet.betType?.toUpperCase() === 'BACK') {
        loss = stake;
      } else if (bet.betType?.toUpperCase() === 'LAY') {
        loss = (odds - 1) * stake;
      }
  
      exposureBySelection.set(
        selectionId,
        (exposureBySelection.get(selectionId) || 0) + loss,
      );
    }
  
    // REAL exposure = max possible loss among all outcomes
    return Math.max(0, ...exposureBySelection.values());
  }
  
  // private async calculateMatchOddsExposure(

  private async settleMarket({
    eventId,
    marketId,
    winnerSelectionId,
    adminId,
    marketType,
    settlementId,
    bets,
    isCancel = false,
  }: {
    eventId: string;
    marketId: string;
    winnerSelectionId: string;
    adminId: string;
    marketType: MarketType;
    settlementId: string;
    bets: any[];
    isCancel?: boolean;
  }): Promise<Set<string>> {
    const winnerSelectionIdNum = Number(winnerSelectionId);
    const affectedUserIds = new Set<string>();

    // 🔐 STRICT VALIDATION: Validate all bets have valid selectionIds before settlement
    const invalidBets = bets.filter(bet => {
      if (!bet.selectionId && bet.selectionId !== 0) return true;
      const betSelectionId = Number(bet.selectionId);
      return isNaN(betSelectionId);
    });

    if (invalidBets.length > 0) {
      const invalidBetIds = invalidBets.map(b => b.id).join(', ');
      throw new BadRequestException(
        `CRITICAL: Found ${invalidBets.length} bets with invalid or missing selectionId. ` +
        `Invalid bet IDs: ${invalidBetIds}. ` +
        `All bets must have valid selectionId (numeric) before settlement. Settlement aborted.`,
      );
    }

    this.logger.log(
      `Starting strict settlement for ${bets.length} bets. ` +
      `settlementId: ${settlementId}, eventId: ${eventId}, marketId: ${marketId}, ` +
      `winnerSelectionId: ${winnerSelectionId} (${winnerSelectionIdNum}), marketType: ${marketType}`,
    );

    // 🔐 STRICT VALIDATION: Match Odds settlement only (Bookmaker uses separate function)
    if (marketType !== MarketType.MATCH_ODDS) {
      throw new BadRequestException(
        `Invalid marketType: ${marketType}. settleMarket only handles MATCH_ODDS. Bookmaker settlement uses a separate function.`,
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        // 1️⃣ Group by user
        const betsByUser = new Map<string, typeof bets>();
        for (const bet of bets) {
          if (!betsByUser.has(bet.userId)) {
            betsByUser.set(bet.userId, []);
          }
          betsByUser.get(bet.userId)!.push(bet);
        }

        // 2️⃣ Settle user by user
        for (const [userId, userBets] of betsByUser.entries()) {
          const wallet = await tx.wallet.findUnique({
            where: { userId },
          });

          if (!wallet) {
            this.logger.warn(`Wallet not found for user ${userId}`);
            continue;
          }

          // ✅ OFFSET DETECTION: Find BACK + LAY pairs with same marketId, selectionId, betValue
          // OFFSET bets are already neutralized at bet placement, so settlement must skip them
          const offsetBetIds = new Set<string>();
          const betMap = new Map<string, { back?: any; lay?: any }>();

          for (const bet of userBets) {
            const betKey = `${bet.marketId}_${bet.selectionId}_${bet.betValue ?? bet.amount ?? 0}`;
            if (!betMap.has(betKey)) {
              betMap.set(betKey, {});
            }
            const pair = betMap.get(betKey)!;
            const betType = bet.betType?.toUpperCase();
            if (betType === 'BACK') {
              pair.back = bet;
            } else if (betType === 'LAY') {
              pair.lay = bet;
            }
          }

          // Mark OFFSET pairs (both BACK and LAY exist with same key)
          for (const [key, pair] of betMap.entries()) {
            if (pair.back && pair.lay) {
              offsetBetIds.add(pair.back.id);
              offsetBetIds.add(pair.lay.id);
              this.logger.debug(
                `OFFSET detected: BACK bet ${pair.back.id} + LAY bet ${pair.lay.id} ` +
                `(marketId: ${pair.back.marketId}, selectionId: ${pair.back.selectionId}, betValue: ${pair.back.betValue ?? pair.back.amount})`,
              );
            }
          }

          // 🔐 SIMPLE SETTLEMENT: Calculate payout per bet and sum
          // Settlement is FINAL PAYOUT ONLY - no adjustments, no complex calculations
          // 
          // Payout rules:
          //   BACK WIN  → stake + (stake * (odds - 1)) = stake * odds
          //   BACK LOSS → 0
          //   LAY WIN   → stake
          //   LAY LOSS  → 0
          //   CANCEL    → stake
          //   OFFSET    → 0 (skip all calculations)
          let totalPayout = 0; // Total amount to add to wallet.balance
          let totalBetLiability = 0; // Total liability to release from wallet.liability

          // 3️⃣ Process each bet and calculate payout (collect updates for batching)
          const betUpdates: Array<{ id: string; status: BetStatus; pnl: number }> = [];
          
          for (const bet of userBets) {
            const stake = bet.betValue ?? bet.amount ?? 0;
            const odds = bet.betRate ?? bet.odds ?? 0;
            const betType = bet.betType?.toUpperCase() || '';
            
            // ✅ OFFSET: Skip all calculations for OFFSET bets
            if (offsetBetIds.has(bet.id)) {
              betUpdates.push({
                id: bet.id,
                status: BetStatus.CANCELLED,
                pnl: 0,
              });
              continue; // Skip all payout/liability calculations
            }

            // CANCEL/TIE: Refund stake
            if (isCancel) {
              const payoutPerBet = stake;
              totalPayout += payoutPerBet;
              betUpdates.push({
                id: bet.id,
                status: BetStatus.CANCELLED,
                pnl: 0,
              });
              continue;
            }

            // ✅ CRITICAL: Settlement ONLY uses eventId, marketId, and selectionId
            // ❌ NEVER use bet.marketType for settlement logic (it's only for UI/grouping)
            // ✅ WIN condition: Compare selectionId (handle both string and number)
            // 🔐 CRITICAL: Ensure selectionId exists and is valid
            if (!bet.selectionId && bet.selectionId !== 0) {
              this.logger.error(
                `CRITICAL: Bet ${bet.id} has no selectionId. Cannot determine win/loss. ` +
                `bet.selectionId: ${bet.selectionId}, betName: ${bet.betName}, ` +
                `settlementId: ${bet.settlementId}`,
              );
              throw new BadRequestException(
                `Bet ${bet.id} has no selectionId. Cannot settle bet without selectionId.`,
              );
            }
            
            const betSelectionId = Number(bet.selectionId);
            if (isNaN(betSelectionId)) {
              this.logger.error(
                `CRITICAL: Bet ${bet.id} has invalid selectionId. ` +
                `bet.selectionId: ${bet.selectionId} (cannot convert to number)`,
              );
              throw new BadRequestException(
                `Bet ${bet.id} has invalid selectionId: ${bet.selectionId}. SelectionId must be a number.`,
              );
            }
            
            const isWinner = betSelectionId === winnerSelectionIdNum;
            
            this.logger.debug(
              `Settling bet ${bet.id}: bet.selectionId=${bet.selectionId} (${betSelectionId}), ` +
              `winnerSelectionId=${winnerSelectionId} (${winnerSelectionIdNum}), isWinner=${isWinner}, ` +
              `betType=${bet.betType}, betName=${bet.betName}`,
            );

            // BACK BET
            if (bet.betType?.toUpperCase() === 'BACK') {
              // ✅ BACK: Always release stake liability (both WIN and LOSS)
              totalBetLiability += stake;
              
              if (isWinner) {
                // BACK WIN: stake + (stake * (odds - 1)) = stake * odds
                const payoutPerBet = stake * odds;
                totalPayout += payoutPerBet;
                const profit = stake * (odds - 1); // For reporting only
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.WON,
                  pnl: profit,
                });
              } else {
                // BACK LOSS: 0 payout
                totalPayout += 0;
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.LOST,
                  pnl: -stake,
                });
              }
            }

            // LAY BET
            if (bet.betType?.toUpperCase() === 'LAY') {
              if (!isWinner) {
                // ✅ CLIENT RULE: LAY WIN = stake + profit
                const profit = this.layLiability(stake, odds); // stake * (odds - 1)
                const payoutPerBet = stake + profit;           // FULL RETURN
                totalPayout += payoutPerBet;
                // ✅ Release ONLY locked liability (profit part)
                totalBetLiability += profit;
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.WON,
                  pnl: profit,
                });
              } else {
                // LAY LOSS: 0 payout + DO NOT release liability
                totalPayout += 0;
                const liab = this.layLiability(stake, odds); // For reporting only
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.LOST,
                  pnl: -liab,
                });
              }
            }
          }

          // 🚀 BATCH UPDATE: Update all bets at once instead of individually
          if (betUpdates.length > 0) {
            const now = new Date();
            await Promise.all(
              betUpdates.map((update) =>
                tx.bet.update({
                  where: { id: update.id },
                  data: {
                    status: update.status,
                    // @ts-ignore
                    pnl: update.pnl,
                    settledAt: now,
                    updatedAt: now,
                  },
                }),
              ),
            );
          }

          // 4️⃣ Apply wallet changes ONCE per user
          // SIMPLE RULE: Add payout to balance, release liability
          // balance += totalPayout (what user receives)
          // liability -= totalBetLiability (release locked funds)
          
          // 🛡️ SAFETY: Ensure liability never goes negative
          const currentLiability = wallet.liability ?? 0;
          const newLiability = Math.max(0, currentLiability - totalBetLiability);

          // 🔍 DETAILED LOGGING: Track liability release for debugging
          this.logger.log(
            `[WALLET UPDATE] User ${userId}: ` +
            `currentBalance=${wallet.balance}, totalPayout=${totalPayout}, newBalance=${wallet.balance + totalPayout}, ` +
            `currentLiability=${currentLiability}, totalBetLiability=${totalBetLiability}, newLiability=${newLiability}, ` +
            `betsCount=${userBets.length}`,
          );

          if (totalPayout !== 0 || totalBetLiability !== 0) {
            await tx.wallet.update({
              where: { userId },
              data: {
                balance: wallet.balance + totalPayout, // Add payout directly
                liability: newLiability, // Release liability (clamped to prevent negative)
              },
            });
            
            this.logger.log(
              `[WALLET UPDATED] User ${userId}: ` +
              `balance: ${wallet.balance} → ${wallet.balance + totalPayout}, ` +
              `liability: ${currentLiability} → ${newLiability} (released ${totalBetLiability})`,
            );

            // Create transaction record (only if payout > 0)
            if (totalPayout > 0) {
              await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount: totalPayout,
                  type: isCancel 
                    ? TransactionType.REFUND 
                    : TransactionType.BET_WON,
                  description: isCancel
                    ? `Settlement CANCEL: Refunded ${totalPayout} - ${settlementId}`
                    : `Settlement: Payout ${totalPayout} - ${settlementId}`,
                },
              });
            }

            // 🔐 LOG settlement details for debugging
            this.logger.log(
              `MATCH_ODDS Settlement for user ${userId}: ` +
              `totalPayout=${totalPayout}, totalBetLiability=${totalBetLiability}, ` +
              `currentBalance=${wallet.balance}, newBalance=${wallet.balance + totalPayout}, ` +
              `currentLiability=${currentLiability}, newLiability=${newLiability}, ` +
              `betsCount=${userBets.length}, settlementId=${settlementId}`,
            );

            affectedUserIds.add(userId);
          }
        }
      },
      {
        maxWait: 15000,
        timeout: 30000,
      },
    );

    this.logger.log(
      `Settlement completed successfully. ` +
      `Settled ${bets.length} bets for ${affectedUserIds.size} users. ` +
      `settlementId: ${settlementId}`,
    );

    return affectedUserIds;
  }

  /**
   * @deprecated This method uses legacy fallback matching which violates strict identity rules.
   * Use strict matching in settleMarketManual instead (bet.eventId === eventId AND bet.marketId === marketId).
   * This method is kept for reference only and should not be used.
   */
  // Helper: Find bets with legacy format support (DEPRECATED - DO NOT USE)
  private async findBetsForSettlement(
    settlementId: string,
    eventId: string,
    marketId: string,
    betIds?: string[],
    legacyFilter?: (bet: any) => boolean,
    marketType?: MarketType, // Add marketType parameter
  ): Promise<any[]> {
    // Find bets with new format first
    let bets = await this.prisma.bet.findMany({
      where: {
        settlementId,
        status: BetStatus.PENDING,
        eventId: eventId,
        marketId: marketId,
        ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
      },
    });

    // If no bets found, try legacy format
    if (bets.length === 0 && legacyFilter) {
      // 🔐 CRITICAL BUG #5 FIX: Add marketType constraint to prevent cross-market contamination
      // ✅ REQUIRED SAFETY RULE: Legacy support must be read-only, never auto-migrate silently
      // 🔐 CRITICAL: For legacy bets, don't require marketId or marketType to match exactly
      // Legacy bets might have different marketId, marketType (like "in_play"), or null values
      // The legacyFilter function will handle matching by settlementId pattern (eventId_selectionId)
      const whereClause: any = {
        eventId: eventId,
        status: BetStatus.PENDING,
        // 🔐 CRITICAL: Exclude fancy bets explicitly (hard guard)
        NOT: [
          { betType: 'YES' },
          { betType: 'NO' },
          { marketType: { contains: 'FANCY', mode: 'insensitive' } },
          { gtype: { contains: 'fancy', mode: 'insensitive' } },
          { settlementId: { startsWith: 'CRICKET:FANCY:' } },
        ],
      };

      // 🔐 CRITICAL: DO NOT add marketType constraint for legacy bets
      // Legacy bets may have marketType like "in_play", "MATCH_ODDS", null, etc.
      // The legacyFilter function will correctly identify match odds vs bookmaker bets
      // Adding marketType constraint here would exclude valid legacy bets

      const allEventBets = await this.prisma.bet.findMany({
        where: whereClause,
      });

      // 🔐 CRITICAL: Apply legacy filter AND hard reject any fancy bets that slipped through
      this.logger.debug(
        `Legacy query found ${allEventBets.length} pending bets for eventId ${eventId}. ` +
        `Applying legacy filter with settlementId: ${settlementId}, marketId: ${marketId}`,
      );
      
      bets = allEventBets.filter((bet) => {
        // Hard reject fancy bets (double-check)
        const isFancyBet = 
          bet.betType === 'YES' ||
          bet.betType === 'NO' ||
          (bet.marketType && bet.marketType.toUpperCase().includes('FANCY')) ||
          (bet.gtype && bet.gtype.toLowerCase().includes('fancy')) ||
          (bet.settlementId && bet.settlementId.startsWith('CRICKET:FANCY:'));
        
        if (isFancyBet) {
          this.logger.error(
            `CRITICAL: Fancy bet ${bet.id} passed through database filter. This should never happen.`,
          );
          return false; // Reject
        }
        
        // Apply legacy filter
        const matches = legacyFilter(bet);
        if (matches) {
          this.logger.debug(
            `Legacy bet ${bet.id} matched filter. ` +
            `settlementId: ${bet.settlementId}, marketId: ${bet.marketId}, ` +
            `selectionId: ${bet.selectionId}, betType: ${bet.betType}`,
          );
        }
        return matches;
      });
      
      this.logger.debug(
        `After legacy filter: ${bets.length} bets matched out of ${allEventBets.length} total bets.`,
      );

      if (bets.length > 0) {
        const betIdsToUpdate = bets.map((b) => b.id).filter((id) => id);
        if (betIdsToUpdate.length > 0) {
          this.logger.log(
            `Found ${betIdsToUpdate.length} legacy bets for eventId ${eventId}. ` +
            `Updating settlementId from legacy format to new format: ${settlementId}`,
          );
          await this.prisma.bet.updateMany({
            where: { id: { in: betIdsToUpdate } },
            data: {
              settlementId: settlementId,
              ...(marketId && { marketId: marketId }),
              ...(eventId && { eventId: eventId }),
            },
          });
          bets = await this.prisma.bet.findMany({
            where: { id: { in: betIdsToUpdate } },
          });
          this.logger.log(
            `Updated ${bets.length} legacy bets with new settlementId format. Proceeding with settlement.`,
          );
        }
      }
    }

    return bets;
  }

  // Helper: Check existing settlement and validate
  private async validateSettlement(
    settlementId: string,
  ): Promise<{ hasExisting: boolean; message?: string }> {
    // @ts-ignore
    const existingSettlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (existingSettlement && !existingSettlement.isRollback) {
      const settledBets = await this.prisma.bet.findMany({
        where: {
          settlementId,
          status: { in: [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED] },
        },
      });

      if (settledBets.length > 0) {
        return {
          hasExisting: true,
          message: `Settlement ${settlementId} already exists and all bets are settled. ` +
            `It was settled by ${existingSettlement.settledBy} on ${existingSettlement.createdAt.toISOString()}. ` +
            `To re-settle, please rollback the existing settlement first.`,
        };
      }
    }

    return { hasExisting: false };
  }

  // Helper: Create/update settlement record
  private async createSettlementRecord(
    settlementId: string,
    eventId: string,
    marketId: string,
    marketType: MarketType,
    winnerSelectionId: string,
    adminId: string,
  ): Promise<void> {
    // @ts-ignore
    await this.prisma.settlement.upsert({
      where: { settlementId },
      update: { isRollback: false, settledBy: adminId, winnerId: winnerSelectionId },
      create: {
        settlementId,
        eventId,
        marketType,
        marketId,
        winnerId: winnerSelectionId,
        settledBy: adminId,
      },
    });
  }

  // Helper: Recalculate P/L for affected users (Fancy-specific)
  private async recalculatePnLForUsersFancy(
    affectedUserIds: Set<string>,
    eventId: string,
  ): Promise<void> {
    await Promise.all(
      Array.from(affectedUserIds).map(async (userId) => {
        try {
          await this.pnlService.recalculateUserPnlAfterSettlement(
            userId,
            eventId,
          );
          // Distribute hierarchical P/L for FANCY market
          // @ts-ignore - userPnl property exists after Prisma client regeneration
          const userPnl = await this.prisma.userPnl.findUnique({
            where: {
              userId_eventId_marketType: {
                userId,
                eventId,
                marketType: MarketType.FANCY,
              },
            },
          });
          if (userPnl) {
            await this.hierarchyPnlService.distributePnL(
              userId,
              eventId,
              MarketType.FANCY,
              userPnl.netPnl,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Failed to recalculate P/L for user ${userId} (Fancy): ${(error as Error).message}`,
          );
        }
      }),
    );
  }

  // Helper: Recalculate P/L for affected users (Generic - for Match Odds and Bookmaker)
  private async recalculatePnLForUsers(
    affectedUserIds: Set<string>,
    eventId: string,
    marketType: MarketType,
  ): Promise<void> {
    await Promise.all(
      Array.from(affectedUserIds).map(async (userId) => {
        try {
          await this.pnlService.recalculateUserPnlAfterSettlement(userId, eventId);
          // @ts-ignore
          const userPnl = await this.prisma.userPnl.findUnique({
            where: {
              userId_eventId_marketType: {
                userId,
                eventId,
                marketType,
              },
            },
          });
          if (userPnl) {
            await this.hierarchyPnlService.distributePnL(
              userId,
              eventId,
              marketType,
              userPnl.netPnl,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Failed to recalculate P/L for user ${userId}: ${(error as Error).message}`,
          );
        }
      }),
    );
  }


  async settleMarketManual(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    marketType: MarketType,
    adminId: string,
    betIds?: string[],
  ) {
    try {
      // 🔐 STRICT VALIDATION: Validate required parameters
      if (!eventId || eventId === 'undefined' || eventId.trim() === '') {
        throw new BadRequestException('eventId is required and cannot be empty');
      }
      if (!marketId || marketId === 'undefined' || marketId.trim() === '') {
        throw new BadRequestException('marketId is required and cannot be empty');
      }
      if (!winnerSelectionId || winnerSelectionId === 'undefined' || winnerSelectionId.trim() === '') {
        throw new BadRequestException('winnerSelectionId is required and cannot be empty');
      }
      if (!adminId || adminId.trim() === '') {
        throw new BadRequestException('adminId is required');
      }
      if (marketType !== MarketType.MATCH_ODDS) {
        throw new BadRequestException('marketType must be MATCH_ODDS. Bookmaker settlement uses a separate function.');
      }

      // 🔐 STRICT RULE: marketId must be the real exchange market ID, never a provider selection ID
      // Validate marketId format (should be numeric string, not a provider ID)
      const marketIdNum = Number(marketId);
      if (isNaN(marketIdNum) || marketIdNum <= 0) {
        throw new BadRequestException(
          `Invalid marketId: ${marketId}. marketId must be a valid exchange market ID (numeric string). ` +
          `Provider selection IDs are not allowed.`,
        );
      }

      // 🔐 STRICT RULE: winnerSelectionId must be the exchange runner selection ID
      const winnerSelectionIdNum = Number(winnerSelectionId);
      if (isNaN(winnerSelectionIdNum) || winnerSelectionIdNum <= 0) {
        throw new BadRequestException(
          `Invalid winnerSelectionId: ${winnerSelectionId}. winnerSelectionId must be a valid exchange runner selection ID (numeric string). ` +
          `Provider IDs are not allowed.`,
        );
      }

      // Build settlement ID for Match Odds
      const settlementId = `CRICKET:MATCHODDS:${eventId}:${marketId}`;

      // 🔐 STRICT MATCHING: Find bets with EXACT matching (NO legacy fallbacks)
      // A bet can be settled ONLY if:
      // 1. bet.eventId === payload.eventId
      // 2. bet.marketId === payload.marketId
      // 3. bet.status === PENDING
      const bets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          marketId: marketId, // 🔐 STRICT: Must match exactly
          status: BetStatus.PENDING,
          // 🔐 STRICT: Reject fancy bets explicitly
          NOT: [
            { betType: 'YES' },
            { betType: 'NO' },
            { marketType: { contains: 'FANCY', mode: 'insensitive' } },
            { gtype: { contains: 'fancy', mode: 'insensitive' } },
            { settlementId: { startsWith: 'CRICKET:FANCY:' } },
          ],
          ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
        },
      });

      // 🔐 STRICT VALIDATION: Validate that all bets belong to the same marketId
      const invalidBets = bets.filter(bet => bet.marketId !== marketId);
      if (invalidBets.length > 0) {
        const invalidBetIds = invalidBets.map(b => b.id).join(', ');
        throw new BadRequestException(
          `CRITICAL: Found ${invalidBets.length} bets with mismatched marketId. ` +
          `Expected marketId: ${marketId}, but found bets with different marketIds. ` +
          `Invalid bet IDs: ${invalidBetIds}. ` +
          `Settlement aborted - all bets must have matching marketId.`,
        );
      }

      // 🔐 STRICT VALIDATION: Validate winnerSelectionId is valid
      // Priority 1: Try to validate against market API (most reliable)
      // Priority 2: If API fails, validate against found bets' selectionIds (fallback)
      let marketDetails: any[] | null = null; // Declared here for reuse in tie handling
      let validSelectionIds: number[] | null = null;

      // Check if eventId is already known to be expired (avoid unnecessary API calls)
      if (this.isEventIdExpired(eventId)) {
        this.logger.debug(
          `Skipping API call for expired eventId ${eventId} (cached). Will validate winnerSelectionId against found bets' selectionIds as fallback.`,
        );
      } else {
        // Try to fetch market details from API (with timeout to avoid blocking settlement)
        try {
          // Use Promise.race to timeout API call after 2 seconds
          const apiResponse = await Promise.race([
            this.aggregatorService.getMatchDetail(eventId),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('API timeout')), 2000)
            ),
          ]) as any;
          marketDetails = Array.isArray(apiResponse) ? apiResponse : null;
        if (marketDetails && marketDetails.length > 0) {
          // Find Match Odds market
          const matchOddsMarket = marketDetails.find((market: any) => {
            const marketName = (market.marketName || '').toLowerCase();
            return (
              marketName === 'match odds' &&
              !marketName.includes('including tie') &&
              !marketName.includes('tied match') &&
              !marketName.includes('completed match')
            );
          });

          if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
            const runners = matchOddsMarket.runners.map((r: any) => Number(r.selectionId));
            validSelectionIds = runners;
            this.logger.log(
              `Market API validation successful. Found ${runners.length} valid runners.`,
            );
          }
        }
        } catch (error: any) {
          // Check if this is a 400 error (invalid/expired eventId) - mark as expired
          const status = error?.details?.status || error?.response?.status;
          const isTimeout = error?.message === 'API timeout';
          
          if (isTimeout) {
            // API timeout - skip validation, use bet-based validation
            this.logger.debug(
              `API call timed out for eventId ${eventId}. Using bet-based validation.`,
            );
          } else if (status === 400) {
            // Mark as expired to avoid future API calls for this eventId
            this.markEventIdAsExpired(eventId);
            this.logger.debug(
              `EventId ${eventId} marked as expired. Will validate winnerSelectionId against found bets' selectionIds as fallback.`,
            );
          } else {
            // API failed for other reasons - will validate against bets instead
            this.logger.debug(
              `Market API validation failed: ${(error as Error).message}. ` +
              `Will validate winnerSelectionId against found bets' selectionIds as fallback.`,
            );
          }
        }
      }

      // If API validation failed or no valid runners found, validate against bets
      if (!validSelectionIds || validSelectionIds.length === 0) {
        if (bets.length === 0) {
          // Can't validate without bets or API - but bets.length check happens later
          // This is just for validation, so continue
        } else {
          // Extract unique selectionIds from found bets
          const betSelectionIds = new Set(
            bets
              .map(bet => {
                const sid = Number(bet.selectionId);
                return isNaN(sid) ? null : sid;
              })
              .filter((id): id is number => id !== null),
          );
          validSelectionIds = Array.from(betSelectionIds);
          this.logger.log(
            `Using bet-based validation (API unavailable). Found ${validSelectionIds.length} unique selectionIds in bets: ${validSelectionIds.join(', ')}`,
          );
        }
      }

      // 🔐 STRICT VALIDATION: Validate winnerSelectionId exists in valid runners/bets
      if (validSelectionIds !== null && validSelectionIds.length > 0) {
        const idsToCheck = validSelectionIds; // TypeScript guard
        if (!idsToCheck.includes(winnerSelectionIdNum)) {
          const validIds = idsToCheck.join(', ');
          throw new BadRequestException(
            `Invalid winnerSelectionId: ${winnerSelectionId} (${winnerSelectionIdNum}). ` +
            `This selectionId does not exist in the market runners or found bets. ` +
            `Valid selectionIds: ${validIds}. ` +
            `Settlement aborted - winnerSelectionId must be a valid runner.`,
          );
        }
      } else {
        // No validation possible - but we have strict matching so this should be safe
        this.logger.warn(
          `Could not validate winnerSelectionId against API or bets. ` +
          `Proceeding with strict matching only (bet.eventId === ${eventId} AND bet.marketId === ${marketId}).`,
        );
      }

      // 🔐 STRICT VALIDATION: Check if settlement already exists
      const validation = await this.validateSettlement(settlementId);
      if (validation.hasExisting) {
        throw new BadRequestException(validation.message);
      }

      // 🔐 STRICT VALIDATION: No bets found after strict filtering
      if (bets.length === 0) {
        throw new BadRequestException(
          `No pending bets found for strict settlement criteria. ` +
          `eventId: ${eventId}, marketId: ${marketId}, winnerSelectionId: ${winnerSelectionId}. ` +
          `Settlement requires exact matching: bet.eventId === ${eventId} AND bet.marketId === ${marketId}. ` +
          `No legacy fallback matching is allowed. If you believe bets should exist, verify the marketId is correct.`,
        );
      }

      this.logger.log(
        `Found ${bets.length} pending bets for strict settlement. ` +
        `settlementId: ${settlementId}, eventId: ${eventId}, marketId: ${marketId}, winnerSelectionId: ${winnerSelectionId}`,
      );

      // 🔐 STRICT TIE HANDLING: Check for tie result using market runners
      // ✅ CORRECT RULE: Market runners define outcome - never bets
      let isCancel = false;
      // Reuse marketDetails if already fetched, otherwise try to fetch (but check cache first)
      if (!marketDetails) {
        // Check if eventId is already known to be expired (avoid unnecessary API calls)
        if (this.isEventIdExpired(eventId)) {
          this.logger.debug(
            `Skipping tie detection API call for expired eventId ${eventId} (cached). Will settle normally.`,
          );
          marketDetails = null;
        } else {
          try {
            const apiResponse = await this.aggregatorService.getMatchDetail(eventId);
            marketDetails = Array.isArray(apiResponse) ? apiResponse : null;
          } catch (error: any) {
            // Check if this is a 400 error (invalid/expired eventId) - mark as expired
            const status = error?.details?.status || error?.response?.status;
            if (status === 400) {
              // Mark as expired to avoid future API calls for this eventId
              this.markEventIdAsExpired(eventId);
              this.logger.debug(
                `EventId ${eventId} marked as expired. Skipping tie detection - will settle normally.`,
              );
            } else {
              this.logger.warn(
                `Could not fetch market details for tie detection: ${(error as Error).message}. ` +
                `Skipping tie detection - will settle normally.`,
              );
            }
            marketDetails = null;
          }
        }
      }

      if (marketDetails && Array.isArray(marketDetails)) {
        // Find Match Odds market (not Match Odds Including Tie)
        const matchOddsMarket = marketDetails.find((market: any) => {
          const marketName = (market.marketName || '').toLowerCase();
          return (
            marketName === 'match odds' &&
            !marketName.includes('including tie') &&
            !marketName.includes('tied match') &&
            !marketName.includes('completed match')
          );
        });
        
        if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
          // Check if winnerSelectionId is a tie selection
          const tieOccurred = this.isTieSelectionId(winnerSelectionIdNum, matchOddsMarket.runners);
          
          if (tieOccurred) {
            // Check if market has Tie runner
            const marketHasTieRunner = matchOddsMarket.runners.some((runner: any) => {
              const runnerName = (runner.runnerName || runner.name || '').toLowerCase();
              return runnerName === 'tie' || runnerName === 'the draw' || runnerName === 'draw';
            });
            
            // ✅ CORRECT RULE:
            // - Tie occurred + Tie runner exists → Settle normally (tie wins, others lose)
            // - Tie occurred + Tie runner NOT offered → CANCEL ALL
            isCancel = !marketHasTieRunner;
            
            if (isCancel) {
              this.logger.log(
                `Match Odds settlement: Tie occurred but market had no tie runner. Cancelling all bets.`,
              );
            } else {
              this.logger.log(
                `Match Odds settlement: Tie occurred and market had tie runner. Settling normally.`,
              );
            }
          }
        }
      } else {
        // API unavailable - cannot detect ties, settle normally
        this.logger.warn(
          `Market API unavailable for tie detection. Proceeding with normal settlement. ` +
          `If this is a tie result, it may not be handled correctly.`,
        );
      }

      // Create settlement record
      await this.createSettlementRecord(
        settlementId,
        eventId,
        marketId,
        MarketType.MATCH_ODDS,
        winnerSelectionId,
        adminId,
      );

      // Settle using unified engine
      const affectedUserIds = await this.settleMarket({
        eventId,
        marketId,
        winnerSelectionId,
        adminId,
        marketType: MarketType.MATCH_ODDS,
        settlementId,
        bets,
        isCancel,
      });

      // Recalculate P/L
      await this.recalculatePnLForUsers(affectedUserIds, eventId, MarketType.MATCH_ODDS);

      return { success: true, message: 'Match Odds bets settled successfully' };
    } catch (error) {
      this.logger.error(
        `Error settling Match Odds for eventId ${eventId}, marketId ${marketId}: ${(error as Error).message}`,
        (error as Error).stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to settle Match Odds: ${(error as Error).message}`,
      );
    }
  }

  /**
   * ✅ EXCHANGE-ACCURATE BOOKMAKER SETTLEMENT (V2)
   * 
   * 🔐 CRITICAL: This function is COMPLETELY SEPARATE from Match Odds and Fancy settlement.
   * It does NOT reuse settleMarketManual() to prevent stake double-crediting bugs.
   * 
   * EXCHANGE-ACCURATE BOOKMAKER RULES:
   * 
   * Bet Placement (already implemented):
   *   wallet.balance -= stake
   *   wallet.liability += stake
   * 
   * Settlement Logic:
   *   BACK — WIN:
   *     wallet.balance += profitOnly     // NEVER add stake
   *     wallet.liability -= stake
   * 
   *   BACK — LOSS:
   *     wallet.liability -= stake
   *     // balance unchanged (stake already deducted)
   * 
   *   LAY — WIN:
   *     wallet.liability -= (stake * odds / 100)
   *     // balance unchanged
   * 
   *   LAY — LOSS:
   *     wallet.balance -= (stake * odds / 100)
   *     wallet.liability -= (stake * odds / 100)
   * 
   * @param eventId - Exchange event ID
   * @param marketId - Exchange market ID
   * @param winnerSelectionId - Exchange runner selection ID that won
   * @param adminId - Admin user ID who is settling
   * @param betIds - Optional: settle only specific bets
   */
  async settleBookmakerManualV2(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    adminId: string,
    betIds?: string[],
  ) {
    try {
      // 🔐 STRICT VALIDATION: Validate required parameters
      if (!eventId || eventId === 'undefined' || eventId.trim() === '') {
        throw new BadRequestException('eventId is required and cannot be empty');
      }
      if (!marketId || marketId === 'undefined' || marketId.trim() === '') {
        throw new BadRequestException('marketId is required and cannot be empty');
      }
      if (!winnerSelectionId || winnerSelectionId === 'undefined' || winnerSelectionId.trim() === '') {
        throw new BadRequestException('winnerSelectionId is required and cannot be empty');
      }
      if (!adminId || adminId.trim() === '') {
        throw new BadRequestException('adminId is required');
      }

      // 🔐 STRICT RULE: marketId must be the real exchange market ID
      const marketIdNum = Number(marketId);
      if (isNaN(marketIdNum) || marketIdNum <= 0) {
        throw new BadRequestException(
          `Invalid marketId: ${marketId}. marketId must be a valid exchange market ID (numeric string).`,
        );
      }

      // 🔐 STRICT RULE: winnerSelectionId must be the exchange runner selection ID
      const winnerSelectionIdNum = Number(winnerSelectionId);
      if (isNaN(winnerSelectionIdNum) || winnerSelectionIdNum <= 0) {
        throw new BadRequestException(
          `Invalid winnerSelectionId: ${winnerSelectionId}. winnerSelectionId must be a valid exchange runner selection ID (numeric string).`,
        );
      }

      // Build settlement ID
      const settlementId = `CRICKET:BOOKMAKER:${eventId}:${marketId}`;

      // 🔐 STRICT MATCHING: Find ONLY bookmaker bets
      // Bookmaker gtype variants: 'bookmaker', 'match1', 'match2', etc.
      // Exclude: 'match', 'matchodds' (these are Match Odds), 'fancy'
      const allBets = await this.prisma.bet.findMany({
        where: {
          eventId: eventId,
          marketId: marketId,
          status: BetStatus.PENDING,
          // Exclude fancy and match odds explicitly
          NOT: [
            { gtype: 'matchodds' },
            { gtype: 'match' }, // 'match' is Match Odds, not Bookmaker
            { gtype: 'fancy' },
            { betType: 'YES' },
            { betType: 'NO' },
            { marketType: { contains: 'FANCY', mode: 'insensitive' } },
            { settlementId: { startsWith: 'CRICKET:FANCY:' } },
            { settlementId: { startsWith: 'CRICKET:MATCHODDS:' } },
          ],
          ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
        },
      });

      // Filter to only bookmaker bets: gtype === 'bookmaker' OR (gtype starts with 'match' AND is not 'match' or 'matchodds')
      const bets = allBets.filter(bet => {
        const gtype = bet.gtype?.toLowerCase() || '';
        return (
          gtype === 'bookmaker' ||
          (gtype.startsWith('match') && gtype !== 'match' && gtype !== 'matchodds')
        );
      });

      // 🔐 STRICT VALIDATION: Validate that all bets belong to the same marketId
      const invalidBets = bets.filter(bet => bet.marketId !== marketId);
      if (invalidBets.length > 0) {
        const invalidBetIds = invalidBets.map(b => b.id).join(', ');
        throw new BadRequestException(
          `CRITICAL: Found ${invalidBets.length} bets with mismatched marketId. ` +
          `Expected marketId: ${marketId}, but found bets with different marketIds. ` +
          `Invalid bet IDs: ${invalidBetIds}. ` +
          `Settlement aborted - all bets must have matching marketId.`,
        );
      }

      // 🔐 STRICT VALIDATION: Check if settlement already exists
      const validation = await this.validateSettlement(settlementId);
      if (validation.hasExisting) {
        throw new BadRequestException(validation.message);
      }

      // 🔐 STRICT VALIDATION: No bets found
      if (bets.length === 0) {
        throw new BadRequestException(
          `No pending bookmaker bets found for strict settlement criteria. ` +
          `eventId: ${eventId}, marketId: ${marketId}, winnerSelectionId: ${winnerSelectionId}. ` +
          `Settlement requires exact matching: bet.eventId === ${eventId} AND bet.marketId === ${marketId} AND gtype is bookmaker.`,
        );
      }

      this.logger.log(
        `Found ${bets.length} pending bookmaker bets for strict settlement. ` +
        `settlementId: ${settlementId}, eventId: ${eventId}, marketId: ${marketId}, winnerSelectionId: ${winnerSelectionId}`,
      );

      // Create settlement record
      await this.createSettlementRecord(
        settlementId,
        eventId,
        marketId,
        MarketType.BOOKMAKER,
        winnerSelectionId,
        adminId,
      );

      // Settle using STRICT bookmaker-specific logic (atomic wallet updates)
      const affectedUserIds = await this.settleBookmakerBetsStrict({
        eventId,
        marketId,
        winnerSelectionId,
        adminId,
        settlementId,
        bets,
      });

      // Recalculate P/L
      await this.recalculatePnLForUsers(affectedUserIds, eventId, MarketType.BOOKMAKER);

      return { success: true, message: 'Bookmaker bets settled successfully' };
    } catch (error) {
      this.logger.error(
        `Error settling Bookmaker for eventId ${eventId}, marketId ${marketId}: ${(error as Error).message}`,
        (error as Error).stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to settle Bookmaker: ${(error as Error).message}`,
      );
    }
  }

  /**
   * ✅ BOOKMAKER SETTLEMENT ENGINE (STRICT & ATOMIC)
   * 
   * 🔐 CRITICAL: This function is COMPLETELY SEPARATE from Match Odds and Fancy settlement.
   * It does NOT reuse any shared settlement logic.
   * 
   * EXCHANGE-ACCURATE BOOKMAKER RULES:
   * 
   * BACK BET:
   *   - Liability at placement = stake
   *   - WIN: profit = (stake * odds) / 100, balance += profit, liability -= stake
   *   - LOSS: balance += 0, liability -= stake
   * 
   * LAY BET:
   *   - Liability at placement = (stake * odds) / 100
   *   - WIN (selection loses): balance += 0, liability -= liability
   *   - LOSS (selection wins): balance -= liability, liability -= liability
   * 
   * ⚠️ Stake is NEVER credited back
   * 
   * SAFETY FEATURES:
   * - Idempotent (skips already settled bets)
   * - Atomic wallet updates (increment/decrement only)
   * - Liability clamping (prevents negative values)
   * - Runtime safety guards
   * - Comprehensive logging
   */
  private async settleBookmakerBetsStrict({
    eventId,
    marketId,
    winnerSelectionId,
    adminId,
    settlementId,
    bets,
  }: {
    eventId: string;
    marketId: string;
    winnerSelectionId: string;
    adminId: string;
    settlementId: string;
    bets: any[];
  }): Promise<Set<string>> {
    const winnerSelectionIdNum = Number(winnerSelectionId);
    const affectedUserIds = new Set<string>();

    // 🔐 STRICT VALIDATION: Validate all bets have valid selectionIds
    const invalidBets = bets.filter(bet => {
      if (!bet.selectionId && bet.selectionId !== 0) return true;
      const betSelectionId = Number(bet.selectionId);
      return isNaN(betSelectionId);
    });

    if (invalidBets.length > 0) {
      const invalidBetIds = invalidBets.map(b => b.id).join(', ');
      throw new BadRequestException(
        `CRITICAL: Found ${invalidBets.length} bets with invalid or missing selectionId. ` +
        `Invalid bet IDs: ${invalidBetIds}. ` +
        `All bets must have valid selectionId (numeric) before settlement. Settlement aborted.`,
      );
    }

    this.logger.log(
      `Starting STRICT bookmaker settlement for ${bets.length} bets. ` +
      `settlementId: ${settlementId}, eventId: ${eventId}, marketId: ${marketId}, ` +
      `winnerSelectionId: ${winnerSelectionId} (${winnerSelectionIdNum})`,
    );

    await this.prisma.$transaction(
      async (tx) => {
        // 🔐 HARD GUARD: Abort if ANY bet is already settled (idempotency enforcement)
        const alreadySettledBets = bets.filter(
          bet => bet.status !== BetStatus.PENDING,
        );
        if (alreadySettledBets.length > 0) {
          const settledBetIds = alreadySettledBets.map(b => b.id).join(', ');
          const settledStatuses = alreadySettledBets.map(b => b.status).join(', ');
          throw new BadRequestException(
            `CRITICAL: Settlement aborted. Found ${alreadySettledBets.length} bets that are already settled. ` +
            `Settled bet IDs: ${settledBetIds}. ` +
            `Settled statuses: ${settledStatuses}. ` +
            `Bookmaker settlement requires ALL bets to be PENDING. ` +
            `This prevents double settlement and wallet inflation.`,
          );
        }

        // 1️⃣ Group by user (settle user wallets exactly once)
        const betsByUser = new Map<string, typeof bets>();
        for (const bet of bets) {
          // 🔐 HARD GUARD: Each bet must be PENDING
          if (bet.status !== BetStatus.PENDING) {
            throw new BadRequestException(
              `CRITICAL: Bet ${bet.id} is not PENDING (status: ${bet.status}). ` +
              `Settlement aborted. All bets must be PENDING before settlement.`,
            );
          }

          if (!betsByUser.has(bet.userId)) {
            betsByUser.set(bet.userId, []);
          }
          betsByUser.get(bet.userId)!.push(bet);
        }

        // 2️⃣ Settle user by user (never re-read wallet inside transaction)
        for (const [userId, userBets] of betsByUser.entries()) {
          // Get wallet ID only (for transaction records) - NO balance/liability read needed
          const wallet = await tx.wallet.findUnique({
            where: { userId },
            select: { id: true }, // Only need ID for transaction records
          });

          if (!wallet) {
            this.logger.warn(`Wallet not found for user ${userId}`);
            continue;
          }

          // Track deltas for atomic update (NO wallet read needed - we use increment/decrement)
          let balanceDelta = 0;
          let liabilityDelta = 0;

          // 🚀 OPTIMIZATION: Collect bet updates for batching
          const betUpdates: Array<{ id: string; status: BetStatus; pnl: number }> = [];

          // 3️⃣ Process each bet with BOOKMAKER-SPECIFIC rules
          for (const bet of userBets) {
            // 🔐 HARD GUARD: Bet status already validated before transaction
            // Skip redundant status check to improve performance

            const stake = Number(bet.betValue ?? bet.amount ?? 0);
            const odds = Number(bet.betRate ?? bet.odds ?? 0);
            const betType = bet.betType?.toUpperCase() || '';

            // Validate selectionId
            if (!bet.selectionId && bet.selectionId !== 0) {
              this.logger.error(
                `CRITICAL: Bet ${bet.id} has no selectionId. Cannot determine win/loss.`,
              );
              throw new BadRequestException(
                `Bet ${bet.id} has no selectionId. Cannot settle bet without selectionId.`,
              );
            }

            const betSelectionId = Number(bet.selectionId);
            if (isNaN(betSelectionId)) {
              this.logger.error(
                `CRITICAL: Bet ${bet.id} has invalid selectionId: ${bet.selectionId}`,
              );
              throw new BadRequestException(
                `Bet ${bet.id} has invalid selectionId: ${bet.selectionId}. SelectionId must be a number.`,
              );
            }

            const isWinner = betSelectionId === winnerSelectionIdNum;

            // ✅ BOOKMAKER BACK BET
            if (betType === 'BACK') {
              // Rule: Liability at placement = stake
              // Always release liability (stake was added at placement)
              const stakeLiability = stake;
              
              if (isWinner) {
                // ✅ BACK WIN: balance += profit ONLY, liability -= stake
                // ⚠️ CRITICAL: Stake is NEVER credited back - only profit
                // Profit = (stake * odds) / 100
                const profit = this.bookmakerBackProfit(stake, odds);
                balanceDelta += profit; // ✅ Credit profit ONLY
                liabilityDelta -= stake; // ✅ Release liability
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.WON,
                  pnl: profit,
                });
              } else {
                // ✅ BACK LOSS: liability -= stake ONLY
                // ⚠️ CRITICAL: Balance unchanged (stake already deducted at placement)
                // NO balance change - stake was already deducted when bet was placed
                liabilityDelta -= stake; // ✅ Release liability ONLY
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.LOST,
                  pnl: -stake,
                });
              }
            }

            // ✅ BOOKMAKER LAY BET
            if (betType === 'LAY') {
              // Rule: Liability at placement = (stake * odds) / 100
              const layLiability = this.bookmakerLayLiability(stake, odds);
              
              if (!isWinner) {
                // ✅ LAY WIN (selection loses): liability -= (stake * odds / 100)
                // ⚠️ CRITICAL: Balance unchanged (no money movement)
                // Only release liability
                liabilityDelta -= layLiability; // ✅ Release liability ONLY
                const profit = stake; // For reporting only (NOT credited to balance)
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.WON,
                  pnl: profit,
                });
              } else {
                // ✅ LAY LOSS (selection wins): balance -= (stake * odds / 100), liability -= (stake * odds / 100)
                // ⚠️ CRITICAL: Deduct loss amount = liability (we pay opponent)
                balanceDelta -= layLiability; // ✅ Deduct loss
                liabilityDelta -= layLiability; // ✅ Release liability
                betUpdates.push({
                  id: bet.id,
                  status: BetStatus.LOST,
                  pnl: -layLiability,
                });
              }
            }
          }

          // 🚀 BATCH UPDATE: Update all bets at once instead of individually
          if (betUpdates.length > 0) {
            const now = new Date();
            await Promise.all(
              betUpdates.map((update) =>
                tx.bet.update({
                  where: { id: update.id },
                  data: {
                    status: update.status,
                    // @ts-ignore
                    pnl: update.pnl,
                    settledAt: now,
                    updatedAt: now,
                  },
                }),
              ),
            );
          }

          // 🧾 LOG settlement summary (reduced verbosity)
          if (betUpdates.length > 0) {
            this.logger.log(
              `BOOKMAKER Settlement for userId=${userId}: ` +
              `bets=${betUpdates.length}, balanceDelta=${balanceDelta}, liabilityDelta=${liabilityDelta}`,
            );
          }

          // 4️⃣ PREVENT DOUBLE LIABILITY RELEASE: Clamp liability to prevent negative values
          // Rule: liabilityDelta must be <= 0 (we only release liability, never add it)
          const clampedLiabilityDelta = Math.min(0, liabilityDelta);

          // 5️⃣ SAFETY GUARDS (MANDATORY) - Prevent wallet inflation
          if (Math.abs(balanceDelta) > 100000) {
            throw new BadRequestException(
              `CRITICAL: Abnormal bookmaker balance delta detected. ` +
              `userId: ${userId}, balanceDelta: ${balanceDelta}. ` +
              `This may indicate a calculation error or data corruption. Settlement aborted.`,
            );
          }

          // 6️⃣ Apply wallet changes ONCE per user (ATOMIC UPDATE ONLY)
          // ✅ REQUIRED: Use increment/decrement (NEVER compute wallet.balance = oldBalance + delta)
          // This prevents wallet inflation from stale snapshots or race conditions
          if (balanceDelta !== 0 || clampedLiabilityDelta !== 0) {
            // ✅ ATOMIC: Prisma handles concurrency - no wallet read needed
            await tx.wallet.update({
              where: { userId },
              data: {
                balance: { increment: balanceDelta }, // ✅ ATOMIC: Never use direct assignment
                liability: { increment: clampedLiabilityDelta }, // ✅ ATOMIC: Never use direct assignment
              },
            });

            // Create transaction record
            if (balanceDelta > 0) {
              await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount: balanceDelta,
                  type: TransactionType.BET_WON,
                  description: `Bookmaker Settlement: Profit credited ${balanceDelta} - ${settlementId}`,
                },
              });
            } else if (balanceDelta < 0) {
              await tx.transaction.create({
                data: {
                  walletId: wallet.id,
                  amount: Math.abs(balanceDelta),
                  type: TransactionType.BET_PLACED, // Using BET_PLACED for loss deduction
                  description: `Bookmaker Settlement: Loss deducted ${Math.abs(balanceDelta)} - ${settlementId}`,
                },
              });
            }

            this.logger.log(
              `Bookmaker wallet updated (ATOMIC) for userId=${userId}: ` +
              `balanceDelta=${balanceDelta}, liabilityDelta=${clampedLiabilityDelta}. ` +
              `Using increment/decrement - no wallet read needed.`,
            );

            affectedUserIds.add(userId);
          }
        }
      },
      {
        maxWait: 15000,
        timeout: 30000,
      },
    );

    this.logger.log(
      `STRICT Bookmaker settlement completed successfully. ` +
      `Settled ${bets.length} bets for ${affectedUserIds.size} users. ` +
      `settlementId: ${settlementId}`,
    );

    return affectedUserIds;
  }

  // @deprecated Use settleBookmakerManualV2 instead
  async settleBookmakerManual(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    adminId: string,
    betIds?: string[],
  ) {
    return this.settleBookmakerManualV2(
      eventId,
      marketId,
      winnerSelectionId,
      adminId,
      betIds,
    );
  }

  // @deprecated Use settleMarketManual instead
  async settleMatchOddsManual(
    eventId: string,
    marketId: string,
    winnerSelectionId: string,
    adminId: string,
    betIds?: string[],
  ) {
    return this.settleMarketManual(
      eventId,
      marketId,
      winnerSelectionId,
      MarketType.MATCH_ODDS,
      adminId,
      betIds,
    );
  }

  /**
   * Calculate NET P/L for a bet based on bet type and outcome
   * 
   * ⚠️ CRITICAL: This function is FOR REPORTING ONLY
   * ❌ NEVER use this to update wallet.balance
   * ✅ ONLY use this to calculate bet.pnl for reporting
   * 
   * EXCHANGE RULES:
   * BACK bet:
   *   - WIN: Profit = stake × (odds - 1)
   *   - LOSS: Loss = -stake
   * 
   * LAY bet:
   *   - WIN: Profit = stake (opponent loses)
   *   - LOSS: Loss = -stake × (odds - 1) (pay out opponent)
   * 
   * CANCEL: Refund = stake (lossAmount)
   *    * @deprecated This function is kept for reference but should not be used.
   * All settlement methods now calculate PNL inline for clarity.
   */



  /**
   * 🔥 UNIVERSAL LIABILITY RECALC (REAL CRICKET EXCHANGE RULES)
   * 
   * ⚠️ CRITICAL: This function ONLY updates liability, NEVER touches balance.
   * 
   * REAL EXCHANGE RULES:
   * - BACK bet: liability = stake
   * - LAY bet: liability = (odds - 1) * stake
   * - Net exposure per selection = |BACK liability - LAY liability|
   * - Total liability = sum of net exposures across all selections
   * 
   * CRITICAL ARCHITECTURE:
   * - ❌ NEVER update balance here (causes fake refunds on LOSS)
   * - ✅ ONLY update liability (wallet changes happen in settlement)
   * - ✅ Wallet updates are handled explicitly in settlement methods:
   *   - WIN: credit profit only
   *   - LOSS: no wallet change
   *   - CANCEL: credit stake
   */
  private async recalcLiability(tx: any, userId: string): Promise<void> {
    const bets = await tx.bet.findMany({
      where: { userId, status: BetStatus.PENDING },
      select: {
        matchId: true,
        selectionId: true,
        betType: true,
        betValue: true,
        amount: true,
        odds: true,
        betRate: true,
      },
    });

    // REAL EXCHANGE: Calculate net exposure per selection using correct liability
    const exposureBySelection = new Map<string, { back: number; lay: number }>();
    
    for (const bet of bets) {
      const key = `${bet.matchId}_${bet.selectionId}`;
      if (!exposureBySelection.has(key)) {
        exposureBySelection.set(key, { back: 0, lay: 0 });
      }
      const exposure = exposureBySelection.get(key)!;
      
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      
      if (bet.betType?.toUpperCase() === 'BACK') {
        // BACK bet: liability = stake
        exposure.back += stake;
      } else if (bet.betType?.toUpperCase() === 'LAY') {
        // LAY bet: liability = (odds - 1) * stake
        exposure.lay += (odds - 1) * stake;
      }
    }

    // Calculate total net liability: sum of |back liability - lay liability| for each selection
    let newLiability = 0;
    for (const [key, exposure] of exposureBySelection.entries()) {
      const netExposure = Math.abs(exposure.back - exposure.lay);
      newLiability += netExposure;
    }

    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      this.logger.warn(`Wallet not found for user ${userId} during liability recalculation`);
      return;
    }

    const currentLiability = wallet.liability ?? 0;
    const diff = newLiability - currentLiability;

    // CRITICAL FIX: ONLY update liability, NEVER touch balance
    // Balance changes are handled explicitly in settlement methods
    await tx.wallet.update({
      where: { userId },
      data: {
        liability: newLiability,
        // ❌ REMOVED: balance update (causes fake refunds on LOSS)
        // ✅ Wallet updates happen explicitly in settlement:
        //    - WIN: credit profit only
        //    - LOSS: no wallet change
        //    - CANCEL: credit stake
      },
    });

    if (diff < 0) {
      this.logger.debug(
        `Liability recalculation for user ${userId}: Liability decreased by ${Math.abs(diff)} (old: ${currentLiability}, new: ${newLiability}). Wallet will be updated explicitly in settlement.`,
      );
    } else if (diff > 0) {
      // This shouldn't happen during settlement (liability should only decrease)
      // But log it for debugging
      this.logger.debug(
        `Liability recalculation for user ${userId}: Increased by ${diff} (old: ${currentLiability}, new: ${newLiability})`,
      );
    }
  }


  // async rollbackSettlement(settlementId: string, adminId: string, betIds?: string[]) {
  //   try {
  //     // @ts-ignore - settlement property exists after Prisma client regeneration
  //     const settlement = await this.prisma.settlement.findUnique({
  //       where: { settlementId },
  //     });

  //     if (!settlement) {
  //       throw new BadRequestException(
  //         `Settlement ${settlementId} not found`,
  //       );
  //     }

  //     if (settlement.isRollback) {
  //       throw new BadRequestException(
  //         `Settlement ${settlementId} has already been rolled back`,
  //       );
  //     }

  //     this.logger.log(
  //       `Rolling back settlement ${settlementId} by admin ${adminId}. Market: ${settlement.marketType}, Event: ${settlement.eventId}`,
  //     );

  //   const bets = await this.prisma.bet.findMany({
  //     where: {
  //       settlementId,
  //       status: {
  //         in: [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED],
  //       },
  //       // Filter by betIds if provided
  //       ...(betIds && betIds.length > 0 && { id: { in: betIds } }),
  //     },
  //   });

  //   if (bets.length === 0) {
  //     this.logger.warn(
  //       `No settled bets found for settlement ${settlementId}. Proceeding with settlement rollback only.`,
  //     );
  //   }

  //   // CRITICAL FIX: Add transaction timeout to prevent "Transaction not found" errors
  //   // This is especially important with pooled connections (Neon, etc.) and when rolling back many bets
  //   await this.prisma.$transaction(
  //     async (tx) => {
  //       // Group bets by userId to optimize wallet updates (reduce number of updates)
  //       const betsByUserId = new Map<string, typeof bets>();
  //       for (const bet of bets) {
  //         if (!betsByUserId.has(bet.userId)) {
  //           betsByUserId.set(bet.userId, []);
  //         }
  //         betsByUserId.get(bet.userId)!.push(bet);
  //       }

  //       // Process each user's bets
  //       const userIdsForRecalc = new Set<string>();
        
  //       for (const [userId, userBets] of betsByUserId.entries()) {
  //         // Reset all bets for this user to PENDING
  //         const betIds = userBets.map((b) => b.id);
  //         await tx.bet.updateMany({
  //           where: {
  //             id: { in: betIds },
  //           },
  //           data: {
  //             status: BetStatus.PENDING,
  //             // @ts-ignore - pnl field exists after database migration
  //             pnl: 0, // Reset PNL (reporting only)
  //             rollbackAt: new Date(),
  //             settledAt: null,
  //             updatedAt: new Date(),
  //           },
  //         });
          
  //         userIdsForRecalc.add(userId);
  //       }

  //       // CRITICAL: Use recalcLiability() to restore wallet state
  //       // This is the ONLY place wallet.balance changes
  //       // After resetting bets to PENDING, recalcLiability will:
  //       // 1. Calculate new liability from all PENDING bets (including restored ones)
  //       // 2. Restore balance based on liability difference
  //       for (const userId of userIdsForRecalc) {
  //         await this.recalcLiability(tx, userId);
  //       }

  //       // Mark settlement as rollbacked
  //       // @ts-ignore - settlement property exists after Prisma client regeneration
  //       await tx.settlement.update({
  //         where: { settlementId },
  //         data: {
  //           isRollback: true,
  //           settledBy: adminId,
  //         },
  //       });
  //     },
  //     {
  //       maxWait: 15000, // Maximum time to wait for a transaction slot (15 seconds)
  //       timeout: 30000, // Maximum time the transaction can run (30 seconds - longer for rollback with many bets)
  //     },
  //   );

  //   // Delete hierarchical PnL ledger records (NO WALLET REVERSAL - wallet is never touched in PnL distribution)
  //   const userIds = new Set(bets.map((b) => b.userId));
  //   for (const userId of userIds) {
  //     try {
  //       // Delete hierarchical PnL ledger records
  //       // Wallet balance is never updated by hierarchy PnL, so no reversal needed
  //       // @ts-ignore - hierarchyPnl property exists after Prisma client regeneration
  //       await this.prisma.hierarchyPnl.deleteMany({
  //         where: {
  //           eventId: settlement.eventId,
  //           marketType: settlement.marketType,
  //           fromUserId: userId, // sourceUserId (original client)
  //         },
  //       });
  //     } catch (error) {
  //       this.logger.warn(
  //         `Failed to delete hierarchical PnL records for user ${userId} during rollback: ${(error as Error).message}`,
  //       );
  //     }
  //   }

  //     // Recalculate P/L for all affected users after rollback in parallel (OPTIMIZED)
  //     await Promise.all(
  //       Array.from(userIds).map(async (userId) => {
  //         try {
  //           await this.pnlService.recalculateUserPnlAfterSettlement(
  //             userId,
  //             settlement.eventId,
  //           );
  //         } catch (error) {
  //           this.logger.warn(
  //             `Failed to recalculate P/L for user ${userId} after rollback: ${(error as Error).message}`,
  //           );
  //         }
  //       }),
  //     );

  //     this.logger.log(
  //       `Settlement ${settlementId} rolled back successfully. ${bets.length} bets reset to PENDING.`,
  //     );

  //     return { success: true, message: 'Settlement rolled back successfully' };
  //   } catch (error) {
  //     this.logger.error(
  //       `Error rolling back settlement ${settlementId}: ${(error as Error).message}`,
  //       (error as Error).stack,
  //     );

  //     // Re-throw BadRequestException as-is
  //     if (error instanceof BadRequestException) {
  //       throw error;
  //     }

  //     // Handle transaction errors specifically
  //     const errorMessage = error instanceof Error ? error.message : String(error);
  //     const isTransactionError =
  //       errorMessage.includes('Transaction not found') ||
  //       errorMessage.includes('Transaction') ||
  //       errorMessage.includes('P2034') || // Prisma transaction timeout error code
  //       errorMessage.includes('P2035'); // Prisma transaction error code

  //     if (isTransactionError) {
  //       throw new BadRequestException(
  //         `Transaction failed during rollback. Please try again. If the issue persists, the database connection may be experiencing issues. Error: ${errorMessage}`,
  //       );
  //     }

  //     // Wrap other errors in BadRequestException for proper HTTP response
  //     throw new BadRequestException(
  //       `Failed to rollback settlement: ${errorMessage}`,
  //     );
  //   }
  // }

  /**
   * Delete a bet for a specific user (Admin only)
   * Releases liability and restores wallet state
   * Can delete by betId or settlementId
   * 
   * IMPORTANT: This method ONLY works for PENDING bets.
   * ASIAN CRICKET EXCHANGE RULE:
   * - Balance was deducted at bet placement (stake amount)
   * - Liability tracks net exposure across all bets
   * - When bet is deleted, recalcLiability() will:
   *   1. Recalculate net exposure (excluding deleted bet)
   *   2. Credit back the difference to balance
   * 
   * This is safe because:
   * - Only PENDING bets can be deleted (enforced by status check)
   * - Settled bets should use rollbackSettlement instead
   */
  async deleteBet(betIdOrSettlementId: string, adminId: string) {
    // Try to find bet by ID first, then by settlementId
    let bet = await this.prisma.bet.findFirst({
      where: {
        OR: [
          { id: betIdOrSettlementId },
          { settlementId: betIdOrSettlementId },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
      },
    });

    if (!bet) {
      throw new BadRequestException(
        `Bet not found with ID or settlementId: ${betIdOrSettlementId}`,
      );
    }

    // Only allow deletion of PENDING bets
    if (bet.status !== BetStatus.PENDING) {
      throw new BadRequestException(
        `Cannot delete bet with status ${bet.status}. Only PENDING bets can be deleted.`,
      );
    }

    // Get wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: bet.userId },
    });

    if (!wallet) {
      throw new BadRequestException(`Wallet not found for user ${bet.userId}`);
    }

    // Calculate refund amount for logging/audit (stake was deducted at placement)
    // In Asian exchange: exposure = stake (betValue) for both BACK and LAY
    const refundAmount = bet.betValue || bet.amount || 0;

    // ASIAN EXCHANGE RULE: Delete bet and use recalcLiability() to restore wallet
    // When bet is deleted:
    // 1. Delete the bet (removes it from PENDING bets)
    // 2. Call recalcLiability() which will:
    //    - Recalculate net exposure (excluding deleted bet)
    //    - Credit back the difference to balance
    await this.prisma.$transaction(async (tx) => {
      // Delete the bet first
      await tx.bet.delete({
        where: { id: bet.id },
      });

      // Create refund transaction record (for audit trail)
      await tx.transaction.create({
        data: {
          walletId: wallet.id,
          amount: refundAmount,
          type: TransactionType.REFUND,
          description: `Bet deleted by admin. Bet ID: ${bet.id}, Settlement ID: ${bet.settlementId || 'N/A'}, Bet Name: ${bet.betName || 'N/A'}`,
        },
      });

      // CRITICAL: Recalculate liability (bet deleted, so liability decreases)
      await this.recalcLiability(tx, bet.userId);
      
      // CRITICAL: Explicitly credit the stake (like CANCEL - refund the locked liability)
      // Calculate the liability that was released
      const stake = bet.betValue ?? bet.amount ?? 0;
      const odds = bet.betRate ?? bet.odds ?? 0;
      
      let releasedLiability = 0;
      if (bet.betType?.toUpperCase() === 'BACK') {
        releasedLiability = stake;
      } else if (bet.betType?.toUpperCase() === 'LAY') {
        releasedLiability = (odds - 1) * stake;
      }
      
      // Credit the released liability (refund)
      if (releasedLiability > 0) {
        await tx.wallet.update({
          where: { userId: bet.userId },
          data: { balance: { increment: releasedLiability } },
        });
      }
    });

    this.logger.log(
      `Bet ${bet.id} (settlementId: ${bet.settlementId || 'N/A'}) deleted by admin ${adminId}. Refunded ${refundAmount} to user ${bet.userId}`,
    );

    return {
      success: true,
      message: 'Bet deleted successfully',
      data: {
        betId: bet.id,
        settlementId: bet.settlementId,
        userId: bet.userId,
        userName: bet.user.name,
        refundAmount,
      },
    };
  }

  /**
   * Cancel all pending bets for a specific market/event/selection and refund all affected users
   * 
   * This method cancels all pending bets matching the criteria and refunds all users who placed those bets.
   * Supports cancellation by:
   * - settlementId (e.g., "CRICKET:MATCHODDS:35100660:6571503686236")
   * - eventId + marketId (for Match Odds/Bookmaker markets)
   * - eventId + selectionId (for Fancy markets)
   * - eventId only (all markets for the event)
   * 
   * @param adminId - Admin user ID who is performing the cancellation
   * @param filters - Filter criteria to select which bets to cancel
   * @returns Summary of cancelled bets and refunds
   */
  async cancelBetsBulk(
    adminId: string,
    filters: {
      settlementId?: string;
      eventId?: string;
      marketId?: string;
      selectionId?: string;
      betIds?: string[];
    },
  ) {
    try {
      // Build where clause for finding bets to cancel
      const whereClause: any = {
        status: BetStatus.PENDING,
      };

      // Filter by settlementId if provided (most specific)
      if (filters.settlementId) {
        whereClause.settlementId = filters.settlementId;
      } else if (filters.eventId) {
        whereClause.eventId = filters.eventId;
        
        // Add marketId filter if provided (for Match Odds/Bookmaker)
        if (filters.marketId) {
          whereClause.marketId = filters.marketId;
        }
        
        // Add selectionId filter if provided (for Fancy)
        if (filters.selectionId) {
          whereClause.selectionId = Number(filters.selectionId);
        }
      } else if (filters.betIds && filters.betIds.length > 0) {
        // Filter by specific bet IDs
        whereClause.id = { in: filters.betIds };
      } else {
        throw new BadRequestException(
          'At least one filter must be provided: settlementId, eventId, or betIds',
        );
      }

      // Find all pending bets matching the criteria
      const betsToCancel = await this.prisma.bet.findMany({
        where: whereClause,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
            },
          },
        },
      });

      if (betsToCancel.length === 0) {
        return {
          success: true,
          message: 'No pending bets found matching the criteria',
          data: {
            cancelledBetsCount: 0,
            refundedUsersCount: 0,
            totalRefundAmount: 0,
            cancelledBets: [],
          },
        };
      }

      // Group bets by user for efficient wallet updates
      const betsByUser = new Map<string, typeof betsToCancel>();
      for (const bet of betsToCancel) {
        if (!betsByUser.has(bet.userId)) {
          betsByUser.set(bet.userId, []);
        }
        betsByUser.get(bet.userId)!.push(bet);
      }

      const cancelledBets: Array<{
        betId: string;
        userId: string;
        userName: string;
        refundAmount: number;
      }> = [];
      let totalRefundAmount = 0;

      // Cancel bets and refund users in a transaction
      await this.prisma.$transaction(
        async (tx) => {
          // Process each user's bets
          for (const [userId, userBets] of betsByUser.entries()) {
            // Get wallet
            const wallet = await tx.wallet.findUnique({
              where: { userId },
            });

            if (!wallet) {
              this.logger.warn(`Wallet not found for user ${userId}`);
              continue;
            }

            let totalUserRefund = 0;
            let totalLiabilityRelease = 0;

            // Process each bet for this user
            for (const bet of userBets) {
              const stake = bet.betValue ?? bet.amount ?? 0;
              const odds = bet.betRate ?? bet.odds ?? 0;
              const betType = bet.betType?.toUpperCase() || '';

              // Calculate liability/refund amount based on bet type
              let refundAmount = 0;
              let liabilityRelease = 0;

              if (betType === 'BACK' || betType === 'YES') {
                // BACK/YES: liability = stake
                refundAmount = stake;
                liabilityRelease = stake;
              } else if (betType === 'LAY' || betType === 'NO') {
                // LAY/NO: For Match Odds, liability = (odds - 1) * stake
                // For Fancy, check lossAmount
                if (bet.lossAmount) {
                  refundAmount = bet.lossAmount;
                  liabilityRelease = bet.lossAmount;
                } else {
                  liabilityRelease = (odds - 1) * stake;
                  refundAmount = liabilityRelease;
                }
              } else {
                // Fallback: use stake
                refundAmount = stake;
                liabilityRelease = stake;
              }

              // Update bet status to CANCELLED
              await tx.bet.update({
                where: { id: bet.id },
                data: {
                  status: BetStatus.CANCELLED,
                  // @ts-ignore
                  pnl: 0, // No P/L for cancelled bets
                  settledAt: new Date(),
                  updatedAt: new Date(),
                },
              });

              totalUserRefund += refundAmount;
              totalLiabilityRelease += liabilityRelease;

              cancelledBets.push({
                betId: bet.id,
                userId: bet.userId,
                userName: bet.user.name || bet.user.username || 'Unknown',
                refundAmount,
              });
            }

            // Update wallet: credit refund and release liability
            if (totalUserRefund > 0 || totalLiabilityRelease > 0) {
              // Safety check: Ensure liability doesn't go negative
              // Get current wallet state to check liability
              const currentWallet = await tx.wallet.findUnique({
                where: { userId },
                select: { liability: true },
              });
              
              const currentLiability = currentWallet?.liability ?? 0;
              const newLiability = Math.max(0, currentLiability - totalLiabilityRelease);
              
              await tx.wallet.update({
                where: { userId },
                data: {
                  balance: { increment: totalUserRefund },
                  liability: newLiability,
                },
              });

              // Create refund transaction record
              if (totalUserRefund > 0) {
                await tx.transaction.create({
                  data: {
                    walletId: wallet.id,
                    amount: totalUserRefund,
                    type: TransactionType.REFUND,
                    description: `Bulk bet cancellation by admin. ` +
                      `Cancelled ${userBets.length} bet(s). ` +
                      `Settlement ID: ${userBets[0]?.settlementId || 'N/A'}`,
                  },
                });
              }
            }

            totalRefundAmount += totalUserRefund;
          }
        },
        {
          maxWait: 15000,
          timeout: 30000,
        },
      );

      this.logger.log(
        `Bulk bet cancellation completed by admin ${adminId}. ` +
        `Cancelled ${betsToCancel.length} bets for ${betsByUser.size} users. ` +
        `Total refund amount: ${totalRefundAmount}`,
      );

      return {
        success: true,
        message: `Successfully cancelled ${betsToCancel.length} bet(s) and refunded ${betsByUser.size} user(s)`,
        data: {
          cancelledBetsCount: betsToCancel.length,
          refundedUsersCount: betsByUser.size,
          totalRefundAmount,
          cancelledBets,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error cancelling bets bulk: ${(error as Error).message}`,
        (error as Error).stack,
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to cancel bets: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get pending bets for a user
   */
  async getUserPendingBets(userId: string) {
    // OPTIMIZED: Use select instead of include
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: BetStatus.PENDING,
      },
      select: {
        id: true,
        matchId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        settlementId: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get settled bets for a user (WON, LOST, or CANCELLED)
   */
  async getUserSettledBets(
    userId: string,
    status?: 'WON' | 'LOST' | 'CANCELLED',
  ) {
    const statusFilter = status
      ? ([status] as BetStatus[])
      : [BetStatus.WON, BetStatus.LOST, BetStatus.CANCELLED];

    // OPTIMIZED: Use select instead of include
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        status: {
          in: statusFilter,
        },
      },
      select: {
        id: true,
        matchId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        status: true,
        pnl: true,
        settledAt: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
            status: true,
          },
        },
      },
      orderBy: {
        settledAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get all bets for a user with optional status filter
   */
  async getUserBets(userId: string, status?: BetStatus) {
    // OPTIMIZED: Use select instead of include
    const bets = await this.prisma.bet.findMany({
      where: {
        userId,
        ...(status && { status }),
      },
      select: {
        id: true,
        matchId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        status: true,
        pnl: true,
        settledAt: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
    };
  }

  /**
   * Get bet history for a specific user (Admin only)
   * Supports filtering by status, date range, and pagination
   */
  async getUserBetHistory(filters: {
    userId: string;
    status?: string;
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
  }) {
    const {
      userId,
      status,
      limit = 100,
      offset = 0,
      startDate,
      endDate,
    } = filters;

    // Build where clause
    const where: any = {
      userId,
    };

    if (status) {
      where.status = status as BetStatus;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = startDate;
      }
      if (endDate) {
        where.createdAt.lte = endDate;
      }
    }

    // Get total count for pagination
    const totalCount = await this.prisma.bet.count({ where });

    // Get bets with pagination
    const bets = await this.prisma.bet.findMany({
      where,
      select: {
        id: true,
        userId: true,
        matchId: true,
        amount: true,
        betValue: true,
        odds: true,
        betRate: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        gtype: true,
        marketId: true,
        eventId: true,
        selectionId: true,
        status: true,
        pnl: true,
        winAmount: true,
        lossAmount: true,
        settlementId: true,
        settledAt: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
          },
        },
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
            status: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
      skip: offset,
    });

    return {
      success: true,
      data: bets,
      count: bets.length,
      total: totalCount,
      limit,
      offset,
      hasMore: offset + bets.length < totalCount,
    };
  }

  /**
   * Get pending fancy markets only (all users)
   * Returns matches with pending fancy bets grouped by match
   */
  async getPendingFancyMarkets() {
    // OPTIMIZED: Use select instead of include to fetch only needed fields
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        OR: [
          { settlementId: { startsWith: 'CRICKET:FANCY:' } },
          { betType: { in: ['YES', 'NO'] } },
          { marketType: { contains: 'FANCY', mode: 'insensitive' } },
          { gtype: { contains: 'fancy', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        matchId: true,
        eventId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        gtype: true,
        settlementId: true,
        selectionId: true,
        marketId: true,
        betValue: true,
        winAmount: true,
        lossAmount: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Group by matchId (since eventId might be null)
    const matchMap = new Map<
      string,
      {
        eventId: string | null;
        matchId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        fancy: {
          count: number;
          totalAmount: number;
          bets: any[];
        };
      }
    >();

    for (const bet of pendingBets) {
      // Use matchId as key if eventId is not available
      const matchKey = bet.eventId || bet.matchId;

      // Get or create match entry
      if (!matchMap.has(matchKey)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          fancy: { count: 0, totalAmount: 0, bets: [] },
        });
      }

      const matchData = matchMap.get(matchKey)!;
      matchData.fancy.count++;
      matchData.fancy.totalAmount += bet.amount || 0;

      // Extract selectionId for bet data
      let betSelectionId: number | null = null;
      if (bet.selectionId) {
        betSelectionId = Number(bet.selectionId);
      } else {
        const selectionIdStr = this.getSelectionIdFromSettlementId(bet.settlementId || '');
        if (selectionIdStr) {
          betSelectionId = parseInt(selectionIdStr, 10);
        }
      }

      matchData.fancy.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        marketType: bet.marketType,
        settlementId: bet.settlementId,
        eventId: bet.eventId,
        selectionId: betSelectionId,
        marketId: bet.marketId,
        betValue: bet.betValue,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        createdAt: bet.createdAt,
      });
    }

    // Sort by startTime
    const sortedMatches = Array.from(matchMap.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      marketType: 'fancy',
      data: sortedMatches,
      totalMatches: sortedMatches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  /**
   * Get pending bookmaker markets only (all users)
   * Returns matches with pending bookmaker bets grouped by match
   */
  async getPendingBookmakerMarkets() {
    // OPTIMIZED: Use select instead of include to fetch only needed fields
    const allPendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        // Explicitly exclude fancy bets and match odds bets
        NOT: [
          { betType: { in: ['YES', 'NO'] } },
          { settlementId: { startsWith: 'CRICKET:FANCY:' } },
          { marketType: { contains: 'FANCY', mode: 'insensitive' } },
          { gtype: { contains: 'fancy', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        matchId: true,
        eventId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        gtype: true,
        settlementId: true,
        selectionId: true,
        marketId: true,
        betValue: true,
        winAmount: true,
        lossAmount: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Filter in memory to only include bookmaker bets
    const pendingBets = allPendingBets.filter((bet) => {
      const settlementId = bet.settlementId || '';
      const betName = (bet.betName || '').toLowerCase();
      const betMarketType = (bet.marketType || '').toUpperCase();
      const gtype = (bet.gtype || '').toUpperCase();

      // Exclude YES/NO bets (fancy)
      if (bet.betType === 'YES' || bet.betType === 'NO') {
        return false;
      }

      // Exclude if explicitly marked as fancy
      if (settlementId.startsWith('CRICKET:FANCY:') ||
          betMarketType.includes('FANCY') ||
          gtype.includes('FANCY')) {
        return false;
      }

      // Exclude match odds bets
      if (settlementId.startsWith('CRICKET:MATCHODDS:')) {
        return false;
      }

      // Exclude match odds by market type
      if ((betMarketType.includes('MATCH') && betMarketType.includes('ODD')) ||
          betMarketType === 'MATCH_ODDS' ||
          betMarketType === 'MATCHODDS' ||
          (gtype.includes('MATCH') && gtype.includes('ODD'))) {
        return false;
      }

      // Include if settlementId indicates bookmaker
      if (settlementId.startsWith('CRICKET:BOOKMAKER:')) {
        return true;
      }

      // Include if marketType or gtype indicates bookmaker
      if (betMarketType.includes('BOOK') || gtype.includes('BOOK')) {
        return true;
      }

      // Include legacy format (eventId_selectionId) if it's likely bookmaker
      // Legacy bookmaker bets typically have settlementId like "35100851_2" or "35100851_1"
      if (settlementId.includes('_') && 
          !settlementId.startsWith('CRICKET:') &&
          !betName.match(/^\d+$/)) { // Exclude if bet name is just numbers (likely fancy runs)
        // Additional check: if selectionId is a small number (1, 2, 3, etc.), likely bookmaker
        const selectionIdPart = settlementId.split('_').pop();
        if (selectionIdPart && /^[1-9]\d{0,1}$/.test(selectionIdPart)) {
          return true;
        }
      }

      return false;
    });

    // Group by matchId (since eventId might be null)
    const matchMap = new Map<
      string,
      {
        eventId: string | null;
        matchId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        bookmaker: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
      }
    >();

    for (const bet of pendingBets) {
      // Use matchId as key if eventId is not available
      const matchKey = bet.eventId || bet.matchId;

      // Get or create match entry
      if (!matchMap.has(matchKey)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          bookmaker: { count: 0, totalAmount: 0, bets: [], runners: [] },
        });
      }

      const matchData = matchMap.get(matchKey)!;
      matchData.bookmaker.count++;
      matchData.bookmaker.totalAmount += bet.amount || 0;

      // Extract selectionId for bet data
      let betSelectionId: number | null = null;
      if (bet.selectionId) {
        betSelectionId = Number(bet.selectionId);
      } else {
        const selectionIdStr = this.getSelectionIdFromSettlementId(bet.settlementId || '');
        if (selectionIdStr) {
          betSelectionId = parseInt(selectionIdStr, 10);
        }
      }

      matchData.bookmaker.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        marketType: bet.marketType,
        settlementId: bet.settlementId,
        eventId: bet.eventId,
        selectionId: betSelectionId,
        marketId: bet.marketId,
        betValue: bet.betValue,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        createdAt: bet.createdAt,
      });

      // Extract runners from bet selectionId
      if (betSelectionId && !isNaN(betSelectionId)) {
        const existingRunner = matchData.bookmaker.runners.find(
          (r) => r.selectionId === betSelectionId,
        );
        if (!existingRunner) {
          matchData.bookmaker.runners.push({
            selectionId: betSelectionId,
            name: bet.betName || `Selection ${betSelectionId}`,
          });
        }
      }
    }

    // Sort runners by selectionId for consistency
    for (const match of matchMap.values()) {
      match.bookmaker.runners.sort((a, b) => a.selectionId - b.selectionId);
    }

    // Sort by startTime
    const sortedMatches = Array.from(matchMap.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      marketType: 'bookmaker',
      data: sortedMatches,
      totalMatches: sortedMatches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  /**
   * Get pending bookmaker and match odds markets combined (all users)
   * Returns matches with pending bookmaker and match odds bets grouped by match
   */
  async getPendingMarketOddsAndBookmaker() {
    // OPTIMIZED: Fetch all pending bets first, then filter in memory
    // This handles both new format (CRICKET:MATCHODDS:) and legacy format (eventId_selectionId)
    const allPendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        // Explicitly exclude fancy bets only
        NOT: [
          { betType: { in: ['YES', 'NO'] } },
          { settlementId: { startsWith: 'CRICKET:FANCY:' } },
          { marketType: { contains: 'FANCY', mode: 'insensitive' } },
          { gtype: { contains: 'fancy', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        matchId: true,
        eventId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        gtype: true,
        settlementId: true,
        selectionId: true,
        marketId: true,
        betValue: true,
        winAmount: true,
        lossAmount: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Filter in memory to only include match odds and bookmaker bets
    // Since fancy bets are already excluded in the query, we just need to ensure
    // we're including BACK/LAY bets (not YES/NO) and exclude any remaining fancy indicators
    const pendingBets = allPendingBets.filter((bet) => {
      const settlementId = bet.settlementId || '';
      const betName = (bet.betName || '').toLowerCase();
      const betMarketType = (bet.marketType || '').toUpperCase();
      const gtype = (bet.gtype || '').toUpperCase();

      // Exclude YES/NO bets (fancy)
      if (bet.betType === 'YES' || bet.betType === 'NO') {
        return false;
      }

      // Exclude if explicitly marked as fancy
      if (settlementId.startsWith('CRICKET:FANCY:') ||
          betMarketType.includes('FANCY') ||
          gtype.includes('FANCY')) {
        return false;
      }

      // Include if it's BACK or LAY (match odds/bookmaker bets)
      if (bet.betType === 'BACK' || bet.betType === 'LAY') {
        return true;
      }

      // Include if settlementId indicates match odds or bookmaker
      if (settlementId.startsWith('CRICKET:MATCHODDS:') || 
          settlementId.startsWith('CRICKET:BOOKMAKER:')) {
        return true;
      }

      // Include legacy format (eventId_selectionId) if not fancy
      // Legacy match odds/bookmaker bets have settlementId like "35100851_902171"
      if (settlementId.includes('_') && 
          !settlementId.startsWith('CRICKET:') &&
          !betName.match(/^\d+$/)) { // Exclude if bet name is just numbers (likely fancy runs)
        return true;
      }

      // Include if marketType or gtype indicates match odds or bookmaker
      if (betMarketType.includes('MATCH') || 
          betMarketType.includes('ODD') ||
          betMarketType.includes('BOOK') ||
          gtype.includes('ODD') ||
          gtype.includes('MATCH') ||
          gtype.includes('BOOK')) {
        return true;
      }

      return false;
    });

    // Group by matchId (since eventId might be null) and market type
    const matchMap = new Map<
      string,
      {
        eventId: string | null;
        matchId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        matchOdds: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        matchOddsIncludingTie: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        tiedMatch: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        bookmaker: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
      }
    >();

    for (const bet of pendingBets) {
      // Use matchId as key if eventId is not available
      const matchKey = bet.eventId || bet.matchId;

      const settlementId = bet.settlementId || '';
      let marketType: 'matchOdds' | 'matchOddsIncludingTie' | 'tiedMatch' | 'bookmaker' | null = null;
      const betName = (bet.betName || '').toLowerCase();
      const marketName = (bet.marketName || '').toLowerCase();

      // Determine market type from settlementId first
      if (settlementId.startsWith('CRICKET:MATCHODDS:')) {
        // CRITICAL: Separate three market types:
        // 1. Tied Match (Yes/No market)
        // 2. Match Odds Including Tie (2 teams + Tie = 3 runners)
        // 3. Match Odds (2 teams only, no Tie)
        if (
          betName === 'yes' ||
          betName === 'no' ||
          marketName.includes('tied match')
        ) {
          // This is Tied Match market (Yes/No)
          marketType = 'tiedMatch';
        } else if (
          marketName.includes('match odds including tie') ||
          betName === 'tie' ||
          betName === 'the draw'
        ) {
          // This is Match Odds Including Tie (has Tie runner)
          marketType = 'matchOddsIncludingTie';
        } else if (marketName.includes('completed match')) {
          // Skip Completed Match - not supported yet
          continue;
        } else {
          // This is regular Match Odds (2 teams only)
          marketType = 'matchOdds';
        }
      } else if (settlementId.startsWith('CRICKET:BOOKMAKER:')) {
        marketType = 'bookmaker';
      } else {
        // Fallback: Check marketType, marketName, and gtype fields
        const betMarketType = (bet.marketType || '').toUpperCase();
        const betMarketName = (bet.marketName || '').toUpperCase();

        // Check if it's MATCH_ODDS (check both marketType and marketName)
        if (
          (betMarketType.includes('MATCH') && betMarketType.includes('ODD')) ||
          betMarketType === 'MATCH_ODDS' ||
          betMarketType === 'MATCHODDS' ||
          betMarketName === 'MATCH_ODDS' ||
          betMarketName === 'MATCHODDS' ||
          (betMarketName.includes('MATCH') && betMarketName.includes('ODD'))
        ) {
          // CRITICAL: Separate three market types
          if (
            betName === 'yes' ||
            betName === 'no' ||
            marketName.includes('tied match')
          ) {
            marketType = 'tiedMatch';
          } else if (
            marketName.includes('match odds including tie') ||
            betName === 'tie' ||
            betName === 'the draw'
          ) {
            marketType = 'matchOddsIncludingTie';
          } else if (marketName.includes('completed match')) {
            continue;
          } else {
            marketType = 'matchOdds';
          }
        }
        // Check if it's BOOKMAKER
        else if (
          betMarketType.includes('BOOKMAKER') ||
          betMarketType.includes('BOOK') ||
          betMarketType === 'BOOKMAKER' ||
          betMarketName.includes('BOOKMAKER') ||
          betMarketName.includes('BOOK')
        ) {
          marketType = 'bookmaker';
        }
        // Try gtype field as last resort
        else {
          const gtype = (bet.gtype || '').toUpperCase();
          if (gtype.includes('ODD') || gtype.includes('MATCH')) {
            // CRITICAL: Separate three market types
            if (
              betName === 'yes' ||
              betName === 'no' ||
              marketName.includes('tied match')
            ) {
              marketType = 'tiedMatch';
            } else if (
              marketName.includes('match odds including tie') ||
              betName === 'tie' ||
              betName === 'the draw'
            ) {
              marketType = 'matchOddsIncludingTie';
            } else if (marketName.includes('completed match')) {
              continue;
            } else {
              marketType = 'matchOdds';
            }
          } else if (gtype.includes('BOOK')) {
            marketType = 'bookmaker';
          }
        }
      }

      // If still no market type, skip this bet
      if (!marketType) {
        this.logger.warn(
          `Could not determine market type for bet ${bet.id}. settlementId: ${settlementId}, marketType: ${bet.marketType}, gtype: ${bet.gtype}`,
        );
        continue;
      }

      // Get or create match entry
      if (!matchMap.has(matchKey)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          matchOdds: { count: 0, totalAmount: 0, bets: [], runners: [] },
          matchOddsIncludingTie: { count: 0, totalAmount: 0, bets: [], runners: [] },
          tiedMatch: { count: 0, totalAmount: 0, bets: [], runners: [] },
          bookmaker: { count: 0, totalAmount: 0, bets: [], runners: [] },
        });
      }

      const matchData = matchMap.get(matchKey)!;
      const marketData = matchData[marketType];

      marketData.count++;
      marketData.totalAmount += bet.amount || 0;

      // Extract selectionId for bet data
      let betSelectionId: number | null = null;
      if (bet.selectionId) {
        betSelectionId = Number(bet.selectionId);
      } else {
        const selectionIdStr = this.getSelectionIdFromSettlementId(bet.settlementId || '');
        if (selectionIdStr) {
          betSelectionId = parseInt(selectionIdStr, 10);
        }
      }

      marketData.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        marketType: bet.marketType,
        settlementId: bet.settlementId,
        eventId: bet.eventId,
        selectionId: betSelectionId,
        marketId: bet.marketId,
        betValue: bet.betValue,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        createdAt: bet.createdAt,
      });

      // Extract runners from bet selectionId (preferred) or settlementId
      let selectionId: number | null = null;

      if (bet.selectionId) {
        selectionId = Number(bet.selectionId);
      } else {
        // Fallback to parsing settlementId
        const selectionIdStr = this.getSelectionIdFromSettlementId(settlementId);
        if (selectionIdStr) {
          selectionId = parseInt(selectionIdStr, 10);
        }
      }

      if (selectionId && !isNaN(selectionId)) {
        if (marketType === 'matchOdds') {
          // CRITICAL: Match Odds must NOT have Yes/No or Tie runners
          if (betName === 'yes' || betName === 'no' || betName === 'tie' || betName === 'the draw') {
            // This should never happen - log warning
            this.logger.warn(
              `Match Odds bet ${bet.id} has Yes/No/Tie runner. This is invalid.`,
            );
            continue;
          }

          // Check if runner already exists
          const existingRunner = matchData.matchOdds.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            // Add runner with selectionId and name from betName
            matchData.matchOdds.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'matchOddsIncludingTie') {
          // Match Odds Including Tie can have 2 teams + Tie (3 runners total)
          const existingRunner = matchData.matchOddsIncludingTie.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.matchOddsIncludingTie.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'tiedMatch') {
          // Tied Match runners (Yes/No)
          const existingRunner = matchData.tiedMatch.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.tiedMatch.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'bookmaker') {
          // Bookmaker runners (include draw/tie if present)
          // Extract selectionId from bet (supports both exchange selectionIds and provider IDs)
          const existingRunner = matchData.bookmaker.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.bookmaker.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        }
      }
    }

    // Post-process matches: fetch all runners for match odds markets from API
    const processedMatches = await Promise.all(
      Array.from(matchMap.values()).map(async (match) => {
        // Fetch market details if we have match odds, match odds including tie, or tied match bets
        if ((match.matchOdds.count > 0 || match.matchOddsIncludingTie.count > 0 || match.tiedMatch.count > 0) && match.eventId) {
          // Skip if we know this eventId is expired (cached to reduce log noise)
          if (this.isEventIdExpired(match.eventId)) {
            return match;
          }

          // Skip validation for old matches (likely expired) - older than 7 days
          const matchAge = Date.now() - match.startTime.getTime();
          const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
          if (matchAge > sevenDaysInMs) {
            // Auto-mark as expired for very old matches to avoid API calls
            this.markEventIdAsExpired(match.eventId);
            return match;
          }

          try {
            const marketDetails = await this.aggregatorService.getMatchDetail(match.eventId);

            // CRITICAL: Find EXACT "Match Odds" market (exclude "Match Odds Including Tie", "Tied Match", etc.)
            const matchOddsMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return (
                      marketName === 'match odds' &&
                      !marketName.includes('including tie') &&
                      !marketName.includes('tied match') &&
                      !marketName.includes('completed match')
                    );
                  },
                )
              : null;

            // Find "Match Odds Including Tie" market
            const matchOddsIncludingTieMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return marketName === 'match odds including tie';
                  },
                )
              : null;

            // Find "Tied Match" market
            const tiedMatchMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return marketName === 'tied match';
                  },
                )
              : null;

            // Process Match Odds market (same logic as getPendingBetsByMatch)
            if (match.matchOdds.count > 0) {
              if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
                // CRITICAL: Match Odds must have exactly 2 runners (no Yes/No)
                const yesNoRunners = matchOddsMarket.runners.filter((r: any) => {
                  const name = (r.runnerName || r.name || '').toLowerCase();
                  return name === 'yes' || name === 'no';
                });

                if (yesNoRunners.length > 0) {
                  this.logger.warn(
                    `Match Odds market for eventId ${match.eventId} contains Yes/No runners. This is invalid.`,
                  );
                }

                // CRITICAL: Build valid selectionId set from API (source of truth)
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();

                for (const runner of matchOddsMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  const normalizedName = runnerName.toLowerCase();

                  // Skip Yes/No runners (shouldn't exist, but safety check)
                  if (normalizedName === 'yes' || normalizedName === 'no') {
                    continue;
                  }

                  // CRITICAL: Skip Tie/The Draw runners (these belong to Match Odds Including Tie)
                  if (normalizedName === 'tie' || normalizedName === 'the draw' || normalizedName === 'draw') {
                    continue;
                  }

                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }

                // CRITICAL: Only keep runners with valid selectionIds from Match Odds market
                const validRunners: Array<{ selectionId: number; name: string }> = [];

                // First, add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }

                // Then, validate existing runners from bets - only keep if selectionId exists in API
                for (const existingRunner of match.matchOdds.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    // Update name from API if available
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    // Only add if not already in validRunners
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                }

                // Replace runners with validated list
                match.matchOdds.runners = validRunners;

                // CRITICAL: Try to map bets to valid selectionIds by bet name
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                const betsToUpdate: Array<{ betId: string; newSelectionId: number }> = [];
                
                const betsWithValidatedIds = match.matchOdds.bets.map((bet) => {
                  const betSelectionId = bet.selectionId;

                  // If selectionId is valid, keep it
                  if (betSelectionId && !isNaN(betSelectionId) && validBetSelectionIds.has(betSelectionId)) {
                    return bet;
                  }

                  // Try to find matching runner by bet name
                  const betName = (bet.betName || '').trim();
                  const matchingRunner = validRunners.find(r =>
                    r.name.toLowerCase() === betName.toLowerCase() ||
                    r.name === betName
                  );

                  if (matchingRunner) {
                    // 🔐 CRITICAL: Update bet in database with correct selectionId (one-time fix)
                    // This prevents the warning from appearing repeatedly
                    betsToUpdate.push({
                      betId: bet.id,
                      newSelectionId: matchingRunner.selectionId,
                    });
                    
                    this.logger.log(
                      `Auto-correcting bet ${bet.id}: Invalid selectionId ${betSelectionId} → Correct selectionId ${matchingRunner.selectionId} (${matchingRunner.name}). ` +
                      `Database updated. This message appears once per bet.`,
                    );
                    return {
                      ...bet,
                      selectionId: matchingRunner.selectionId,
                      _selectionIdUpdated: true,
                    };
                  }

                  // If we can't match, keep the bet but log warning (only once per bet)
                  this.logger.debug(
                    `Bet ${bet.id} has invalid selectionId ${betSelectionId} and betName "${betName}" doesn't match any valid runner. Keeping bet but it may need manual correction.`,
                  );
                  return bet;
                });

                // 🔐 CRITICAL: Actually update the database with correct selectionIds (batch update)
                if (betsToUpdate.length > 0) {
                  try {
                    await Promise.all(
                      betsToUpdate.map(({ betId, newSelectionId }) =>
                        this.prisma.bet.update({
                          where: { id: betId },
                          data: { selectionId: newSelectionId },
                        }),
                      ),
                    );
                    this.logger.log(
                      `Successfully auto-corrected ${betsToUpdate.length} bet(s) with invalid selectionIds. ` +
                      `SelectionIds have been updated in database.`,
                    );
                  } catch (error) {
                    this.logger.error(
                      `Failed to update selectionIds in database: ${(error as Error).message}`,
                    );
                  }
                }

                // Keep all bets (don't filter out) but update selectionIds where possible
                match.matchOdds.bets = betsWithValidatedIds;

                // Update count and totalAmount
                match.matchOdds.count = match.matchOdds.bets.length;
                match.matchOdds.totalAmount = match.matchOdds.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);

                // CRITICAL: Assert Match Odds has exactly 2 runners (or less if no bets)
                if (match.matchOdds.runners.length > 2) {
                  this.logger.warn(
                    `Match Odds for eventId ${match.eventId} has ${match.matchOdds.runners.length} runners. Expected 2.`,
                  );
                  // Sort and take first 2
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                  match.matchOdds.runners = match.matchOdds.runners.slice(0, 2);
                } else {
                  // Sort runners by selectionId for consistency
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                }
              } else {
                // If API call failed or market not found, keep all bets but log warning
                this.logger.warn(
                  `Match Odds market not found in API for eventId ${match.eventId}. Cannot validate selectionIds. Showing all bets.`,
                );
                // Don't filter bets - show them all even if we can't validate
                // Runners will be from bets only (not from API)
                if (match.matchOdds.runners.length > 0) {
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                }
              }
            }

            // Process Match Odds Including Tie market (same logic as getPendingBetsByMatch)
            if (match.matchOddsIncludingTie.count > 0) {
              if (matchOddsIncludingTieMarket && matchOddsIncludingTieMarket.runners && Array.isArray(matchOddsIncludingTieMarket.runners)) {
                // CRITICAL: Match Odds Including Tie can have 3 runners (2 teams + Tie)
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();

                for (const runner of matchOddsIncludingTieMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }

                const validRunners: Array<{ selectionId: number; name: string }> = [];

                // Add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }

                // Validate existing runners from bets
                for (const existingRunner of match.matchOddsIncludingTie.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                }

                match.matchOddsIncludingTie.runners = validRunners;

                // Filter out bets with invalid selectionIds
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                match.matchOddsIncludingTie.bets = match.matchOddsIncludingTie.bets.filter((bet) => {
                  const betSelectionId = bet.selectionId;
                  if (!betSelectionId || isNaN(betSelectionId)) {
                    return true;
                  }
                  return validBetSelectionIds.has(betSelectionId);
                });

                match.matchOddsIncludingTie.count = match.matchOddsIncludingTie.bets.length;
                match.matchOddsIncludingTie.totalAmount = match.matchOddsIncludingTie.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);

                // Sort runners by selectionId (should be 3: 2 teams + Tie)
                match.matchOddsIncludingTie.runners.sort((a, b) => a.selectionId - b.selectionId);
              } else {
                this.logger.warn(
                  `Match Odds Including Tie market not found in API for eventId ${match.eventId}. Cannot validate selectionIds.`,
                );
              }
            }

            // Process Tied Match market (same logic as getPendingBetsByMatch)
            if (match.tiedMatch.count > 0) {
              if (tiedMatchMarket && tiedMatchMarket.runners && Array.isArray(tiedMatchMarket.runners)) {
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();

                for (const runner of tiedMatchMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }

                const validRunners: Array<{ selectionId: number; name: string }> = [];

                // Add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }

                // Validate existing runners from bets
                for (const existingRunner of match.tiedMatch.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                }

                match.tiedMatch.runners = validRunners;

                // Filter out bets with invalid selectionIds
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                match.tiedMatch.bets = match.tiedMatch.bets.filter((bet) => {
                  const betSelectionId = bet.selectionId;
                  if (!betSelectionId || isNaN(betSelectionId)) {
                    return true;
                  }
                  return validBetSelectionIds.has(betSelectionId);
                });

                match.tiedMatch.count = match.tiedMatch.bets.length;
                match.tiedMatch.totalAmount = match.tiedMatch.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);

                // Sort runners by selectionId
                match.tiedMatch.runners.sort((a, b) => a.selectionId - b.selectionId);
              } else {
                this.logger.warn(
                  `Tied Match market not found in API for eventId ${match.eventId}. Cannot validate selectionIds.`,
                );
              }
            }
          } catch (error: any) {
            // Check if this is a 400 error (invalid/expired eventId) - mark as expired
            const errorMessage = (error as Error).message || '';
            const status = error?.details?.status || error?.response?.status;
            const is400Error = status === 400 || errorMessage.includes('status code 400') || errorMessage.includes('(Status: 400)');
            
            if (is400Error) {
              // Mark as expired to avoid future API calls for this eventId
              // This prevents repeated DEBUG logs for the same expired eventId
              if (match.eventId) {
                this.markEventIdAsExpired(match.eventId);
                // No need to log here - AggregatorService already logged it as DEBUG
              }
            } else {
              // Log other errors (5xx, network errors, etc.) as they're unexpected
              this.logger.debug(
                `Failed to fetch market details for eventId ${match.eventId}: ${errorMessage}`,
              );
            }
          }
        }

        // If match title or awayTeam contains "MATCH_ODDS", try to extract from bets
        if (match.matchTitle.includes('MATCH_ODDS') ||
          match.awayTeam.toUpperCase().includes('MATCH_ODDS') ||
          (!match.awayTeam || match.awayTeam === '')) {

          // Collect unique team names from match odds bets (excluding "The Draw")
          const teamNames = new Set<string>();
          for (const bet of match.matchOdds.bets) {
            if (bet.betName &&
              bet.betName !== 'The Draw' &&
              !bet.betName.toUpperCase().includes('MATCH') &&
              !bet.betName.toUpperCase().includes('ODDS')) {
              teamNames.add(bet.betName.trim());
            }
          }

          // Also collect from runners if available
          for (const runner of match.matchOdds.runners) {
            if (runner.name &&
              runner.name !== 'The Draw' &&
              !runner.name.toUpperCase().includes('MATCH') &&
              !runner.name.toUpperCase().includes('ODDS')) {
              teamNames.add(runner.name.trim());
            }
          }

          // If we found team names, use them
          if (teamNames.size >= 2) {
            const teams = Array.from(teamNames);
            match.matchTitle = `${teams[0]} vs ${teams[1]}`;
            match.homeTeam = teams[0];
            match.awayTeam = teams[1];
          } else if (teamNames.size === 1 && match.homeTeam &&
            !match.homeTeam.toUpperCase().includes('MATCH')) {
            // If we have one team from bets and homeTeam is valid, use both
            const teamFromBet = Array.from(teamNames)[0];
            if (teamFromBet !== match.homeTeam) {
              match.matchTitle = `${match.homeTeam} vs ${teamFromBet}`;
              match.awayTeam = teamFromBet;
            }
          } else if (match.homeTeam && !match.homeTeam.toUpperCase().includes('MATCH')) {
            // If only homeTeam is valid, just show it
            match.matchTitle = match.homeTeam;
          }
        }

        return match;
      }),
    );

    // Sort by startTime
    const sortedMatches = processedMatches.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      marketType: 'bookmaker-and-match-odds',
      data: sortedMatches,
      totalMatches: sortedMatches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  /**
   * Get all pending bets grouped by match and market type
   * Returns matches with pending fancy, match-odds, and bookmaker bets
   */
  /**
   * Extract selectionId from settlementId format: "{marketId}_{selectionId}"
   * Example: "611629359_49050" -> "49050"
   */
  private getSelectionIdFromSettlementId(settlementId: string): string | null {
    if (!settlementId || !settlementId.includes('_')) {
      return null;
    }
    const parts = settlementId.split('_');
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }

  /**
   * Check if a selectionId represents a Tie/Draw result
   * This is used to determine if Match Odds bets should be voided
   * 
   * @param selectionId - The selectionId to check
   * @param bets - Optional array of bets to check bet names for "Tie" or "The Draw"
   * @returns true if this is a Tie selectionId
   */
  private isTieSelectionId(selectionId: number, bets?: any[]): boolean {
    // Common Tie selectionIds from Betfair Match Odds Including Tie market
    // 2312392 = "Tie" in Match Odds Including Tie
    // Note: 37302/37303 are Yes/No in Tied Match market, not Tie in Match Odds
    const knownTieIds = [2312392]; // Common Tie ID in Match Odds Including Tie
    
    if (knownTieIds.includes(selectionId)) {
      return true;
    }
    
    // Additional check: if any bet has this selectionId and betName is Tie/The Draw
    if (bets && bets.length > 0) {
      const betWithThisId = bets.find(b => b.selectionId === selectionId);
      if (betWithThisId) {
        const betName = (betWithThisId.betName || '').toLowerCase();
        if (betName === 'tie' || betName === 'the draw' || betName === 'draw') {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Clean team name by removing market type strings
   */
  private cleanTeamName(teamName: string | null | undefined): string {
    if (!teamName) return '';
    
    // Remove common market type strings
    const marketTypes = ['MATCH_ODDS', 'MATCHODDS', 'FANCY', 'BOOKMAKER', 'BOOK'];
    let cleaned = teamName.trim();
    
    for (const marketType of marketTypes) {
      // Remove exact matches
      if (cleaned.toUpperCase() === marketType) {
        return '';
      }
      // Remove if it's part of the string (case insensitive)
      const regex = new RegExp(`\\b${marketType}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '').trim();
    }
    
    return cleaned;
  }

  /**
   * Get proper match title from bet and match data
   */
  private getMatchTitle(bet: any): string {
    // First priority: eventName from match (usually has the correct format)
    if (bet.match?.eventName) {
      // Clean eventName if it contains market type strings
      const cleanedEventName = this.cleanTeamName(bet.match.eventName);
      if (cleanedEventName && !cleanedEventName.includes('MATCH_ODDS')) {
        return bet.match.eventName;
      }
    }

    // Second priority: Clean homeTeam and awayTeam
    let homeTeam = this.cleanTeamName(bet.match?.homeTeam);
    let awayTeam = this.cleanTeamName(bet.match?.awayTeam);

    // If awayTeam is empty or contains market type, try to extract from betName
    // For match odds, betName often contains the team name
    if (!awayTeam || awayTeam === '' || awayTeam.toUpperCase().includes('MATCH')) {
      // If homeTeam is valid, we might be able to infer awayTeam from context
      // But for now, if we have a valid homeTeam, use it
      if (homeTeam) {
        // Try to get awayTeam from marketName if available
        if (bet.marketName && !bet.marketName.toUpperCase().includes('MATCH_ODDS')) {
          awayTeam = bet.marketName.trim();
        } else {
          // If we can't find awayTeam, just show homeTeam
          return homeTeam;
        }
      }
    }

    // If both teams are valid (not empty after cleaning)
    if (homeTeam && awayTeam && homeTeam !== awayTeam) {
      return `${homeTeam} vs ${awayTeam}`;
    }

    // If only homeTeam is valid
    if (homeTeam && !awayTeam) {
      return homeTeam;
    }

    // Third priority: Try to extract from betName if it contains "vs"
    if (bet.betName && bet.betName.includes(' vs ')) {
      return bet.betName;
    }

    // Fallback: Use original values or defaults
    const finalHomeTeam = homeTeam || bet.match?.homeTeam || 'Team A';
    const finalAwayTeam = awayTeam || bet.match?.awayTeam || 'Team B';
    
    // Only show "vs" if both teams are different and not market types
    if (finalHomeTeam !== finalAwayTeam && 
        !finalHomeTeam.toUpperCase().includes('MATCH') && 
        !finalAwayTeam.toUpperCase().includes('MATCH')) {
      return `${finalHomeTeam} vs ${finalAwayTeam}`;
    }
    
    return finalHomeTeam;
  }

  async getPendingBetsByMatch() {
    // OPTIMIZED: Use select instead of include to fetch only needed fields
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
      },
      select: {
        id: true,
        matchId: true,
        eventId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        marketName: true,
        marketType: true,
        gtype: true,
        settlementId: true,
        selectionId: true,
        marketId: true,
        betValue: true,
        winAmount: true,
        lossAmount: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Group by matchId (since eventId might be null) and market type
    const matchMap = new Map<
      string,
      {
        eventId: string | null;
        matchId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        fancy: {
          count: number;
          totalAmount: number;
          bets: any[];
        };
        matchOdds: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        matchOddsIncludingTie: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        tiedMatch: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
        bookmaker: {
          count: number;
          totalAmount: number;
          bets: any[];
          runners: Array<{
            selectionId: number;
            name: string;
          }>;
        };
      }
    >();

    for (const bet of pendingBets) {
      // Use matchId as key if eventId is not available
      const matchKey = bet.eventId || bet.matchId;
      
      const settlementId = bet.settlementId || '';
      let marketType: 'fancy' | 'matchOdds' | 'matchOddsIncludingTie' | 'tiedMatch' | 'bookmaker' | null = null;
      const betName = (bet.betName || '').toLowerCase();
      const marketName = (bet.marketName || '').toLowerCase();

      // Determine market type from settlementId first
      if (settlementId.startsWith('CRICKET:FANCY:')) {
        marketType = 'fancy';
      } else if (settlementId.startsWith('CRICKET:MATCHODDS:')) {
        // CRITICAL: Separate three market types:
        // 1. Tied Match (Yes/No market)
        // 2. Match Odds Including Tie (2 teams + Tie = 3 runners)
        // 3. Match Odds (2 teams only, no Tie)
        if (
          betName === 'yes' || 
          betName === 'no' ||
          marketName.includes('tied match')
        ) {
          // This is Tied Match market (Yes/No)
          marketType = 'tiedMatch';
        } else if (
          marketName.includes('match odds including tie') ||
          betName === 'tie' || 
          betName === 'the draw'
        ) {
          // This is Match Odds Including Tie (has Tie runner)
          marketType = 'matchOddsIncludingTie';
        } else if (marketName.includes('completed match')) {
          // Skip Completed Match - not supported yet
          continue;
        } else {
          // This is regular Match Odds (2 teams only)
          marketType = 'matchOdds';
        }
      } else if (settlementId.startsWith('CRICKET:BOOKMAKER:')) {
        marketType = 'bookmaker';
      } else {
        // Fallback: Check marketType, marketName, and gtype fields
        const betMarketType = (bet.marketType || '').toUpperCase();
        const betMarketName = (bet.marketName || '').toUpperCase();
        
        // Check if it's FANCY
        if (
          betMarketType.includes('FANCY') || 
          betMarketType === 'FANCY' ||
          betMarketName.includes('FANCY')
        ) {
          marketType = 'fancy';
        } 
        // Check if it's MATCH_ODDS (check both marketType and marketName)
        else if (
          (betMarketType.includes('MATCH') && betMarketType.includes('ODD')) ||
          betMarketType === 'MATCH_ODDS' ||
          betMarketType === 'MATCHODDS' ||
          betMarketName === 'MATCH_ODDS' ||
          betMarketName === 'MATCHODDS' ||
          betMarketName.includes('MATCH') && betMarketName.includes('ODD')
        ) {
          // CRITICAL: Separate three market types
          if (
            betName === 'yes' || 
            betName === 'no' ||
            marketName.includes('tied match')
          ) {
            marketType = 'tiedMatch';
          } else if (
            marketName.includes('match odds including tie') ||
            betName === 'tie' || 
            betName === 'the draw'
          ) {
            marketType = 'matchOddsIncludingTie';
          } else if (marketName.includes('completed match')) {
            continue;
          } else {
            marketType = 'matchOdds';
          }
        } 
        // Check if it's BOOKMAKER
        else if (
          betMarketType.includes('BOOKMAKER') ||
          betMarketType.includes('BOOK') ||
          betMarketType === 'BOOKMAKER' ||
          betMarketName.includes('BOOKMAKER') ||
          betMarketName.includes('BOOK')
        ) {
          marketType = 'bookmaker';
        } 
        // Try gtype field as last resort
        else {
          const gtype = (bet.gtype || '').toUpperCase();
          if (gtype.includes('FANCY')) {
            marketType = 'fancy';
          } else if (gtype.includes('ODD') || gtype.includes('MATCH')) {
            // CRITICAL: Separate three market types
            if (
              betName === 'yes' || 
              betName === 'no' ||
              marketName.includes('tied match')
            ) {
              marketType = 'tiedMatch';
            } else if (
              marketName.includes('match odds including tie') ||
              betName === 'tie' || 
              betName === 'the draw'
            ) {
              marketType = 'matchOddsIncludingTie';
            } else if (marketName.includes('completed match')) {
              continue;
            } else {
              marketType = 'matchOdds';
            }
          } else if (gtype.includes('BOOK')) {
            marketType = 'bookmaker';
          }
        }
      }

      // If still no market type, skip this bet (or we could add an "unknown" category)
      if (!marketType) {
        this.logger.warn(
          `Could not determine market type for bet ${bet.id}. settlementId: ${settlementId}, marketType: ${bet.marketType}, gtype: ${bet.gtype}`,
        );
        continue;
      }

      // Get or create match entry
      if (!matchMap.has(matchKey)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(matchKey, {
          eventId: bet.eventId,
          matchId: bet.matchId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          fancy: { count: 0, totalAmount: 0, bets: [] },
          matchOdds: { count: 0, totalAmount: 0, bets: [], runners: [] },
          matchOddsIncludingTie: { count: 0, totalAmount: 0, bets: [], runners: [] },
          tiedMatch: { count: 0, totalAmount: 0, bets: [], runners: [] },
          bookmaker: { count: 0, totalAmount: 0, bets: [], runners: [] },
        });
      }

      const matchData = matchMap.get(matchKey)!;
      const marketData = matchData[marketType];

      marketData.count++;
      marketData.totalAmount += bet.amount || 0;
      
      // Extract selectionId for bet data
      let betSelectionId: number | null = null;
      if (bet.selectionId) {
        betSelectionId = Number(bet.selectionId);
      } else {
        const selectionIdStr = this.getSelectionIdFromSettlementId(bet.settlementId || '');
        if (selectionIdStr) {
          betSelectionId = parseInt(selectionIdStr, 10);
        }
      }
      
      marketData.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        marketType: bet.marketType,
        settlementId: bet.settlementId,
        eventId: bet.eventId,
        selectionId: betSelectionId,
        marketId: bet.marketId,
        betValue: bet.betValue,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        createdAt: bet.createdAt,
      });

      // Extract runners from bet selectionId (preferred) or settlementId
      let selectionId: number | null = null;
      
      if (bet.selectionId) {
        selectionId = Number(bet.selectionId);
      } else {
        // Fallback to parsing settlementId
        const selectionIdStr = this.getSelectionIdFromSettlementId(settlementId);
        if (selectionIdStr) {
          selectionId = parseInt(selectionIdStr, 10);
        }
      }
      
      if (selectionId && !isNaN(selectionId)) {
        if (marketType === 'matchOdds') {
          // CRITICAL: Match Odds must NOT have Yes/No or Tie runners
          if (betName === 'yes' || betName === 'no' || betName === 'tie' || betName === 'the draw') {
            // This should never happen - log warning
            this.logger.warn(
              `Match Odds bet ${bet.id} has Yes/No/Tie runner. This is invalid.`,
            );
            continue;
          }
          
          // Check if runner already exists
          const existingRunner = matchData.matchOdds.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            // Add runner with selectionId and name from betName
            matchData.matchOdds.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'matchOddsIncludingTie') {
          // Match Odds Including Tie can have 2 teams + Tie (3 runners total)
          const existingRunner = matchData.matchOddsIncludingTie.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.matchOddsIncludingTie.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'tiedMatch') {
          // Tied Match runners (Yes/No)
          const existingRunner = matchData.tiedMatch.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.tiedMatch.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        } else if (marketType === 'bookmaker') {
          // Bookmaker runners (include draw/tie if present)
          // Extract selectionId from bet (supports both exchange selectionIds and provider IDs)
          const existingRunner = matchData.bookmaker.runners.find(
            (r) => r.selectionId === selectionId,
          );
          if (!existingRunner) {
            matchData.bookmaker.runners.push({
              selectionId,
              name: bet.betName || `Selection ${selectionId}`,
            });
          }
        }
      }
    }

    // Post-process matches: fetch all runners for match odds markets from API
    const processedMatches = await Promise.all(
      Array.from(matchMap.values()).map(async (match) => {
        // Fetch market details if we have match odds, match odds including tie, or tied match bets
        if ((match.matchOdds.count > 0 || match.matchOddsIncludingTie.count > 0 || match.tiedMatch.count > 0) && match.eventId) {
          // Skip if we know this eventId is expired (cached to reduce log noise)
          if (this.isEventIdExpired(match.eventId)) {
            return match;
          }

          // Skip validation for old matches (likely expired) - older than 7 days
          const matchAge = Date.now() - match.startTime.getTime();
          const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
          if (matchAge > sevenDaysInMs) {
            // Auto-mark as expired for very old matches to avoid API calls
            this.markEventIdAsExpired(match.eventId);
            return match;
          }

          try {
            const marketDetails = await this.aggregatorService.getMatchDetail(match.eventId);
            
            // CRITICAL: Find EXACT "Match Odds" market (exclude "Match Odds Including Tie", "Tied Match", etc.)
            const matchOddsMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return (
                      marketName === 'match odds' &&
                      !marketName.includes('including tie') &&
                      !marketName.includes('tied match') &&
                      !marketName.includes('completed match')
                    );
                  },
                )
              : null;

            // Find "Match Odds Including Tie" market
            const matchOddsIncludingTieMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return marketName === 'match odds including tie';
                  },
                )
              : null;

            // Find "Tied Match" market
            const tiedMatchMarket = Array.isArray(marketDetails)
              ? marketDetails.find(
                  (market: any) => {
                    const marketName = (market.marketName || '').toLowerCase();
                    return marketName === 'tied match';
                  },
                )
              : null;

            // Process Match Odds market
            if (match.matchOdds.count > 0) {
              if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
                // CRITICAL: Match Odds must have exactly 2 runners (no Yes/No)
                const yesNoRunners = matchOddsMarket.runners.filter((r: any) => {
                  const name = (r.runnerName || r.name || '').toLowerCase();
                  return name === 'yes' || name === 'no';
                });
                
                if (yesNoRunners.length > 0) {
                  this.logger.warn(
                    `Match Odds market for eventId ${match.eventId} contains Yes/No runners. This is invalid.`,
                  );
                }
                
                // CRITICAL: Build valid selectionId set from API (source of truth)
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();
                
                for (const runner of matchOddsMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  const normalizedName = runnerName.toLowerCase();
                  
                  // Skip Yes/No runners (shouldn't exist, but safety check)
                  if (normalizedName === 'yes' || normalizedName === 'no') {
                    continue;
                  }
                  
                  // CRITICAL: Skip Tie/The Draw runners (these belong to Match Odds Including Tie)
                  if (normalizedName === 'tie' || normalizedName === 'the draw' || normalizedName === 'draw') {
                    continue;
                  }
                  
                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }
                
                // CRITICAL: Only keep runners with valid selectionIds from Match Odds market
                const validRunners: Array<{ selectionId: number; name: string }> = [];
                
                // First, add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }
                
                // Then, validate existing runners from bets - only keep if selectionId exists in API
                for (const existingRunner of match.matchOdds.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    // Update name from API if available
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    // Only add if not already in validRunners
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                  // If selectionId doesn't exist in API, it's invalid - don't include it
                }
                
                // Replace runners with validated list
                match.matchOdds.runners = validRunners;
                
                // CRITICAL: Try to map bets to valid selectionIds by bet name
                // If bet selectionId doesn't match API, try to find matching runner by name
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                const betsToUpdate: Array<{ betId: string; newSelectionId: number }> = [];
                
                const betsWithValidatedIds = match.matchOdds.bets.map((bet) => {
                  const betSelectionId = bet.selectionId;
                  
                  // If selectionId is valid, keep it
                  if (betSelectionId && !isNaN(betSelectionId) && validBetSelectionIds.has(betSelectionId)) {
                    return bet;
                  }
                  
                  // Try to find matching runner by bet name
                  const betName = (bet.betName || '').trim();
                  const matchingRunner = validRunners.find(r => 
                    r.name.toLowerCase() === betName.toLowerCase() ||
                    r.name === betName
                  );
                  
                  if (matchingRunner) {
                    // 🔐 CRITICAL: Update bet in database with correct selectionId (one-time fix)
                    // This prevents the warning from appearing repeatedly
                    betsToUpdate.push({
                      betId: bet.id,
                      newSelectionId: matchingRunner.selectionId,
                    });
                    
                    this.logger.log(
                      `Auto-correcting bet ${bet.id}: Invalid selectionId ${betSelectionId} → Correct selectionId ${matchingRunner.selectionId} (${matchingRunner.name}). ` +
                      `Database updated. This message appears once per bet.`,
                    );
                    return {
                      ...bet,
                      selectionId: matchingRunner.selectionId,
                      _selectionIdUpdated: true, // Flag for tracking
                    };
                  }
                  
                  // If we can't match, keep the bet but log warning (only once per bet)
                  this.logger.debug(
                    `Bet ${bet.id} has invalid selectionId ${betSelectionId} and betName "${betName}" doesn't match any valid runner. Keeping bet but it may need manual correction.`,
                  );
                  return bet;
                });
                
                // 🔐 CRITICAL: Actually update the database with correct selectionIds (batch update)
                if (betsToUpdate.length > 0) {
                  try {
                    await Promise.all(
                      betsToUpdate.map(({ betId, newSelectionId }) =>
                        this.prisma.bet.update({
                          where: { id: betId },
                          data: { selectionId: newSelectionId },
                        }),
                      ),
                    );
                    this.logger.log(
                      `Successfully auto-corrected ${betsToUpdate.length} bet(s) with invalid selectionIds. ` +
                      `SelectionIds have been updated in database.`,
                    );
                  } catch (error) {
                    this.logger.error(
                      `Failed to update selectionIds in database: ${(error as Error).message}`,
                    );
                  }
                }
                
                // Keep all bets (don't filter out) but update selectionIds where possible
                match.matchOdds.bets = betsWithValidatedIds;
                
                // Update count and totalAmount
                match.matchOdds.count = match.matchOdds.bets.length;
                match.matchOdds.totalAmount = match.matchOdds.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
                
                // CRITICAL: Assert Match Odds has exactly 2 runners (or less if no bets)
                if (match.matchOdds.runners.length > 2) {
                  this.logger.warn(
                    `Match Odds for eventId ${match.eventId} has ${match.matchOdds.runners.length} runners. Expected 2.`,
                  );
                  // Sort and take first 2
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                  match.matchOdds.runners = match.matchOdds.runners.slice(0, 2);
                } else {
                  // Sort runners by selectionId for consistency
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                }
              } else {
                // If API call failed or market not found, keep all bets but log warning
                this.logger.warn(
                  `Match Odds market not found in API for eventId ${match.eventId}. Cannot validate selectionIds. Showing all bets.`,
                );
                // Don't filter bets - show them all even if we can't validate
                // Runners will be from bets only (not from API)
                if (match.matchOdds.runners.length > 0) {
                  match.matchOdds.runners.sort((a, b) => a.selectionId - b.selectionId);
                }
              }
            }

            // Process Match Odds Including Tie market
            if (match.matchOddsIncludingTie.count > 0) {
              if (matchOddsIncludingTieMarket && matchOddsIncludingTieMarket.runners && Array.isArray(matchOddsIncludingTieMarket.runners)) {
                // CRITICAL: Match Odds Including Tie can have 3 runners (2 teams + Tie)
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();
                
                for (const runner of matchOddsIncludingTieMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }
                
                const validRunners: Array<{ selectionId: number; name: string }> = [];
                
                // Add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }
                
                // Validate existing runners from bets
                for (const existingRunner of match.matchOddsIncludingTie.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                }
                
                match.matchOddsIncludingTie.runners = validRunners;
                
                // Filter out bets with invalid selectionIds
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                match.matchOddsIncludingTie.bets = match.matchOddsIncludingTie.bets.filter((bet) => {
                  const betSelectionId = bet.selectionId;
                  if (!betSelectionId || isNaN(betSelectionId)) {
                    return true;
                  }
                  return validBetSelectionIds.has(betSelectionId);
                });
                
                match.matchOddsIncludingTie.count = match.matchOddsIncludingTie.bets.length;
                match.matchOddsIncludingTie.totalAmount = match.matchOddsIncludingTie.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
                
                // Sort runners by selectionId (should be 3: 2 teams + Tie)
                match.matchOddsIncludingTie.runners.sort((a, b) => a.selectionId - b.selectionId);
              } else {
                this.logger.warn(
                  `Match Odds Including Tie market not found in API for eventId ${match.eventId}. Cannot validate selectionIds.`,
                );
              }
            }

            // Process Tied Match market
            if (match.tiedMatch.count > 0) {
              if (tiedMatchMarket && tiedMatchMarket.runners && Array.isArray(tiedMatchMarket.runners)) {
                const validSelectionIds = new Set<number>();
                const validRunnersMap = new Map<number, string>();
                
                for (const runner of tiedMatchMarket.runners) {
                  const selectionId = runner.selectionId;
                  const runnerName = runner.runnerName || runner.name || `Selection ${selectionId}`;
                  validSelectionIds.add(selectionId);
                  validRunnersMap.set(selectionId, runnerName);
                }
                
                const validRunners: Array<{ selectionId: number; name: string }> = [];
                
                // Add all valid runners from API
                for (const [selectionId, runnerName] of validRunnersMap.entries()) {
                  validRunners.push({
                    selectionId,
                    name: runnerName,
                  });
                }
                
                // Validate existing runners from bets
                for (const existingRunner of match.tiedMatch.runners) {
                  if (validSelectionIds.has(existingRunner.selectionId)) {
                    const apiName = validRunnersMap.get(existingRunner.selectionId);
                    if (apiName && apiName !== existingRunner.name) {
                      existingRunner.name = apiName;
                    }
                    if (!validRunners.find(r => r.selectionId === existingRunner.selectionId)) {
                      validRunners.push(existingRunner);
                    }
                  }
                }
                
                match.tiedMatch.runners = validRunners;
                
                // Filter out bets with invalid selectionIds
                const validBetSelectionIds = new Set(validRunners.map(r => r.selectionId));
                match.tiedMatch.bets = match.tiedMatch.bets.filter((bet) => {
                  const betSelectionId = bet.selectionId;
                  if (!betSelectionId || isNaN(betSelectionId)) {
                    return true;
                  }
                  return validBetSelectionIds.has(betSelectionId);
                });
                
                match.tiedMatch.count = match.tiedMatch.bets.length;
                match.tiedMatch.totalAmount = match.tiedMatch.bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
                
                // Sort runners by selectionId
                match.tiedMatch.runners.sort((a, b) => a.selectionId - b.selectionId);
              } else {
                this.logger.warn(
                  `Tied Match market not found in API for eventId ${match.eventId}. Cannot validate selectionIds.`,
                );
              }
            }
          } catch (error: any) {
            // Check if this is a 400 error (invalid/expired eventId) - mark as expired
            const errorMessage = (error as Error).message || '';
            const status = error?.details?.status || error?.response?.status;
            const is400Error = status === 400 || errorMessage.includes('status code 400') || errorMessage.includes('(Status: 400)');
            
            if (is400Error) {
              // Mark as expired to avoid future API calls for this eventId
              // This prevents repeated DEBUG logs for the same expired eventId
              if (match.eventId) {
                this.markEventIdAsExpired(match.eventId);
                // No need to log here - AggregatorService already logged it as DEBUG
              }
            } else {
              // Log other errors (5xx, network errors, etc.) as they're unexpected
              this.logger.debug(
                `Failed to fetch market details for eventId ${match.eventId}: ${errorMessage}`,
              );
            }
          }
        }

      // If match title or awayTeam contains "MATCH_ODDS", try to extract from bets
      if (match.matchTitle.includes('MATCH_ODDS') || 
          match.awayTeam.toUpperCase().includes('MATCH_ODDS') ||
          (!match.awayTeam || match.awayTeam === '')) {
        
        // Collect unique team names from match odds bets (excluding "The Draw")
        const teamNames = new Set<string>();
        for (const bet of match.matchOdds.bets) {
          if (bet.betName && 
              bet.betName !== 'The Draw' && 
              !bet.betName.toUpperCase().includes('MATCH') &&
              !bet.betName.toUpperCase().includes('ODDS')) {
            teamNames.add(bet.betName.trim());
          }
        }

          // Also collect from runners if available
          for (const runner of match.matchOdds.runners) {
            if (runner.name && 
                runner.name !== 'The Draw' && 
                !runner.name.toUpperCase().includes('MATCH') &&
                !runner.name.toUpperCase().includes('ODDS')) {
              teamNames.add(runner.name.trim());
            }
          }

        // If we found team names, use them
        if (teamNames.size >= 2) {
          const teams = Array.from(teamNames);
          match.matchTitle = `${teams[0]} vs ${teams[1]}`;
          match.homeTeam = teams[0];
          match.awayTeam = teams[1];
        } else if (teamNames.size === 1 && match.homeTeam && 
                   !match.homeTeam.toUpperCase().includes('MATCH')) {
          // If we have one team from bets and homeTeam is valid, use both
          const teamFromBet = Array.from(teamNames)[0];
          if (teamFromBet !== match.homeTeam) {
            match.matchTitle = `${match.homeTeam} vs ${teamFromBet}`;
            match.awayTeam = teamFromBet;
          }
        } else if (match.homeTeam && !match.homeTeam.toUpperCase().includes('MATCH')) {
          // If only homeTeam is valid, just show it
          match.matchTitle = match.homeTeam;
        }
      }

      return match;
      }),
    );

    // Sort by startTime
    const sortedMatches = processedMatches.sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      data: sortedMatches,
      totalMatches: sortedMatches.length,
      totalPendingBets: pendingBets.length,
    };
  }

  /**
   * Get all settlements with detailed information
   * Includes bet counts, amounts, and can be filtered
   */
  async getAllSettlements(filters?: {
    eventId?: string;
    marketType?: MarketType;
    isRollback?: boolean;
    settledBy?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }) {
    const where: any = {};

    if (filters?.eventId) {
      where.eventId = filters.eventId;
    }

    if (filters?.marketType) {
      where.marketType = filters.marketType;
    }

    if (filters?.isRollback !== undefined) {
      where.isRollback = filters.isRollback;
    }

    if (filters?.settledBy) {
      where.settledBy = filters.settledBy;
    }

    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) {
        where.createdAt.gte = filters.startDate;
      }
      if (filters.endDate) {
        where.createdAt.lte = filters.endDate;
      }
    }

    const settlements = await this.prisma.settlement.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      take: filters?.limit || 100,
      skip: filters?.offset || 0,
    });

    // OPTIMIZED: Batch fetch all bets for all settlements in a single query
    const settlementIds = settlements.map((s) => s.settlementId);
    const allBetsRaw = settlementIds.length > 0
      ? await this.prisma.bet.findMany({
          where: {
            settlementId: { in: settlementIds },
          },
          select: {
            id: true,
            userId: true,
            settlementId: true,
            amount: true,
            odds: true,
            betType: true,
            betName: true,
            status: true,
            pnl: true,
            settledAt: true,
            rollbackAt: true,
            createdAt: true,
            match: {
              select: {
                id: true,
                homeTeam: true,
                awayTeam: true,
                eventName: true,
                eventId: true,
              },
            },
          },
        })
      : [];

    // Fetch users separately to handle missing users gracefully
    const userIds = [...new Set(allBetsRaw.map(b => b.userId).filter((id): id is string => id !== null))];
    const users = userIds.length > 0
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            name: true,
            username: true,
          },
        })
      : [];
    
    const usersMap = new Map(users.map(u => [u.id, u]));
    
    // Join users to bets
    const allBets = allBetsRaw.map(bet => ({
      ...bet,
      user: bet.userId ? usersMap.get(bet.userId) || null : null,
    }));

    // Group bets by settlementId for O(1) lookup
    const betsBySettlementId = new Map<string, typeof allBets>();
    for (const bet of allBets) {
      if (bet.settlementId) {
        if (!betsBySettlementId.has(bet.settlementId)) {
          betsBySettlementId.set(bet.settlementId, []);
        }
        betsBySettlementId.get(bet.settlementId)!.push(bet);
      }
    }

    // OPTIMIZED: Batch fetch all matches for settlements without bets
    const eventIds = settlements.map((s) => s.eventId).filter((id) => id);
    const uniqueEventIds = [...new Set(eventIds)];
    const matchesByEventId = new Map<string, any>();
    
    if (uniqueEventIds.length > 0) {
      const matches = await this.prisma.match.findMany({
        where: {
          eventId: { in: uniqueEventIds },
        },
        select: {
          id: true,
          eventId: true,
          eventName: true,
          homeTeam: true,
          awayTeam: true,
        },
      });
      
      for (const match of matches) {
        if (match.eventId) {
          matchesByEventId.set(match.eventId, match);
        }
      }
    }

    // Get detailed information for each settlement (now using pre-fetched bets)
    const settlementsWithDetails = settlements.map((settlement) => {
        // Get all bets for this settlement from pre-fetched map
        const bets = betsBySettlementId.get(settlement.settlementId) || [];

        // Calculate statistics
        const totalBets = bets.length;
        const wonBets = bets.filter((b) => b.status === BetStatus.WON).length;
        const lostBets = bets.filter((b) => b.status === BetStatus.LOST).length;
        const cancelledBets = bets.filter(
          (b) => b.status === BetStatus.CANCELLED,
        ).length;

        const totalStake = bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
        const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);
        const totalWinAmount = bets
          .filter((b) => b.status === BetStatus.WON)
          .reduce((sum, bet) => sum + (bet.pnl || 0), 0);
        const totalLossAmount = Math.abs(
          bets
            .filter((b) => b.status === BetStatus.LOST)
            .reduce((sum, bet) => sum + (bet.pnl || 0), 0),
        );

        // Get match info from first bet, or fetch from Match table if no bets
        let matchInfo = bets[0]?.match || null;
        if (!matchInfo && settlement.eventId) {
          matchInfo = matchesByEventId.get(settlement.eventId) || null;
        }

        return {
          id: settlement.id,
          settlementId: settlement.settlementId,
          eventId: settlement.eventId,
          marketType: settlement.marketType,
          marketId: settlement.marketId,
          winnerId: settlement.winnerId,
          settledBy: settlement.settledBy,
          isRollback: settlement.isRollback,
          createdAt: settlement.createdAt,
          match: matchInfo
            ? {
                id: matchInfo.id,
                eventId: matchInfo.eventId,
                eventName: matchInfo.eventName,
                homeTeam: matchInfo.homeTeam,
                awayTeam: matchInfo.awayTeam,
              }
            : null,
          statistics: {
            totalBets,
            wonBets,
            lostBets,
            cancelledBets,
            totalStake,
            totalPnl,
            totalWinAmount,
            totalLossAmount,
          },
          bets: bets.map((bet) => ({
            id: bet.id,
            userId: bet.userId,
            userName: bet.user?.name || null,
            userUsername: bet.user?.username || null,
            amount: bet.amount,
            odds: bet.odds,
            betType: bet.betType,
            betName: bet.betName,
            status: bet.status,
            pnl: bet.pnl,
            settledAt: bet.settledAt,
            rollbackAt: bet.rollbackAt,
          createdAt: bet.createdAt,
        })),
      };
    });

    // Get total count for pagination
    const totalCount = await this.prisma.settlement.count({ where });

    return {
      success: true,
      data: settlementsWithDetails,
      pagination: {
        total: totalCount,
        limit: filters?.limit || 100,
        offset: filters?.offset || 0,
        hasMore: (filters?.offset || 0) + settlements.length < totalCount,
      },
    };
  }

  /**
   * Get a single settlement by settlementId with full details
   */
  async getSettlementById(settlementId: string) {
    // @ts-ignore - settlement property exists after Prisma client regeneration
    const settlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (!settlement) {
      throw new BadRequestException(`Settlement not found: ${settlementId}`);
    }

    // OPTIMIZED: Use select instead of include (already optimized)
    const bets = await this.prisma.bet.findMany({
      where: {
        settlementId: settlement.settlementId,
      },
      select: {
        id: true,
        userId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        status: true,
        pnl: true,
        settledAt: true,
        rollbackAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            username: true,
          },
        },
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
          },
        },
      },
    });

    // Calculate statistics
    const totalBets = bets.length;
    const wonBets = bets.filter((b) => b.status === BetStatus.WON).length;
    const lostBets = bets.filter((b) => b.status === BetStatus.LOST).length;
    const cancelledBets = bets.filter(
      (b) => b.status === BetStatus.CANCELLED,
    ).length;

    const totalStake = bets.reduce((sum, bet) => sum + (bet.amount || 0), 0);
    const totalPnl = bets.reduce((sum, bet) => sum + (bet.pnl || 0), 0);
    const totalWinAmount = bets
      .filter((b) => b.status === BetStatus.WON)
      .reduce((sum, bet) => sum + (bet.pnl || 0), 0);
    const totalLossAmount = Math.abs(
      bets
        .filter((b) => b.status === BetStatus.LOST)
        .reduce((sum, bet) => sum + (bet.pnl || 0), 0),
    );

    const matchInfo = bets[0]?.match || null;

    return {
      success: true,
      data: {
        id: settlement.id,
        settlementId: settlement.settlementId,
        eventId: settlement.eventId,
        marketType: settlement.marketType,
        marketId: settlement.marketId,
        winnerId: settlement.winnerId,
        settledBy: settlement.settledBy,
        isRollback: settlement.isRollback,
        createdAt: settlement.createdAt,
        match: matchInfo
          ? {
              id: matchInfo.id,
              eventId: matchInfo.eventId,
              eventName: matchInfo.eventName,
              homeTeam: matchInfo.homeTeam,
              awayTeam: matchInfo.awayTeam,
            }
          : null,
        statistics: {
          totalBets,
          wonBets,
          lostBets,
          cancelledBets,
          totalStake,
          totalPnl,
          totalWinAmount,
          totalLossAmount,
        },
        bets: bets.map((bet) => ({
          id: bet.id,
          userId: bet.userId,
          userName: bet.user.name,
          userUsername: bet.user.username,
          amount: bet.amount,
          odds: bet.odds,
          betType: bet.betType,
          betName: bet.betName,
          status: bet.status,
          pnl: bet.pnl,
          settledAt: bet.settledAt,
          rollbackAt: bet.rollbackAt,
          createdAt: bet.createdAt,
        })),
      },
    };
  }

  /**
   * Get pending bets for a specific market type
   */
  async getPendingBetsByMarketType(marketType: 'fancy' | 'match-odds' | 'bookmaker') {
    const settlementPrefix =
      marketType === 'fancy'
        ? 'CRICKET:FANCY:'
        : marketType === 'match-odds'
          ? 'CRICKET:MATCHODDS:'
          : 'CRICKET:BOOKMAKER:';

    // OPTIMIZED: Use select instead of include
    const pendingBets = await this.prisma.bet.findMany({
      where: {
        status: BetStatus.PENDING,
        settlementId: {
          startsWith: settlementPrefix,
        },
        eventId: {
          not: null,
        },
      },
      select: {
        id: true,
        matchId: true,
        eventId: true,
        amount: true,
        odds: true,
        betType: true,
        betName: true,
        settlementId: true,
        createdAt: true,
        match: {
          select: {
            id: true,
            homeTeam: true,
            awayTeam: true,
            eventName: true,
            eventId: true,
            startTime: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Group by eventId
    const matchMap = new Map<
      string,
      {
        eventId: string;
        matchTitle: string;
        homeTeam: string;
        awayTeam: string;
        startTime: Date;
        bets: any[];
        totalAmount: number;
      }
    >();

    for (const bet of pendingBets) {
      if (!bet.eventId) continue;

      if (!matchMap.has(bet.eventId)) {
        const matchTitle = this.getMatchTitle(bet);
        const homeTeam = this.cleanTeamName(bet.match?.homeTeam) || bet.match?.homeTeam || '';
        const awayTeam = this.cleanTeamName(bet.match?.awayTeam) || bet.match?.awayTeam || '';

        matchMap.set(bet.eventId, {
          eventId: bet.eventId,
          matchTitle,
          homeTeam,
          awayTeam,
          startTime: bet.match?.startTime || new Date(),
          bets: [],
          totalAmount: 0,
        });
      }

      const matchData = matchMap.get(bet.eventId)!;
      matchData.bets.push({
        id: bet.id,
        amount: bet.amount,
        odds: bet.odds,
        betType: bet.betType,
        betName: bet.betName,
        settlementId: bet.settlementId,
        createdAt: bet.createdAt,
      });
      matchData.totalAmount += bet.amount || 0;
    }

    const matches = Array.from(matchMap.values()).sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );

    return {
      success: true,
      marketType,
      data: matches,
      totalMatches: matches.length,
      totalPendingBets: pendingBets.length,
    };
  }

}
