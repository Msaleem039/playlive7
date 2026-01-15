import { Injectable } from '@nestjs/common';
import { Bet } from '@prisma/client';

/**
 * Position Service
 * 
 * Calculates positions (P/L projections) for each market type based on OPEN bets ONLY.
 * 
 * 🚨 CRITICAL RULES:
 * 1. Position is NOT stored in DB - it's calculated fresh every time
 * 2. Position is NOT incremental - always recalculated from all open bets
 * 3. Position logic NEVER touches wallet or DB - pure functions only
 * 4. Markets are NEVER mixed - Match Odds, Fancy, Bookmaker are isolated
 * 
 * Position is UI/display only and separated from exposure/wallet logic.
 */

export interface BetInput {
  selectionId: string | number;
  betType: 'BACK' | 'LAY';
  odds: number;
  stake: number;
}

/**
 * Minimal Bet fields required for position calculation
 */
export type BetForPosition = Pick<
  Bet,
  | 'gtype'
  | 'marketId'
  | 'eventId'
  | 'selectionId'
  | 'betType'
  | 'betValue'
  | 'amount'
  | 'betRate'
  | 'odds'
  | 'winAmount'
  | 'lossAmount'
  | 'status'
  | 'marketId'
  | 'betName'
>;

/**
 * Match Odds Position Result
 */
export interface MatchOddsPosition {
  marketId: string;
  positions: Record<string, { profit: number; loss: number }>;
}

/**
 * Fancy Position Result
 */
export interface FancyPosition {
  fancyId: string; // eventId_selectionId
  name?: string;
  positions: {
    YES: number;
    NO: number;
  };
}

/**
 * Bookmaker Position Result
 */
export interface BookmakerPosition {
  marketId: string;
  positions: Record<string, { profit: number; loss: number }>; // selectionId -> { profit, loss }
}

/**
 * Complete Position Result
 */
export interface AllPositions {
  matchOdds?: MatchOddsPosition;
  fancy?: FancyPosition[];
  bookmaker?: BookmakerPosition;
}

/**
 * ✅ PURE FUNCTION: Calculate Match Odds Position
 * 
 * Match Odds Position Rules:
 * - Aggregates ONLY bets with gtype='matchodds' or gtype='match'
 * - Position per selection: { profit, loss }
 *   - profit: Total P/L if this selection WINS (aggregates all bets)
 *   - loss: Same as profit (UI compatibility - represents P/L for this outcome)
 * 
 * Exchange-standard calculation:
 * - For each outcome: Calculate total P/L if that outcome wins
 * - BACK bet on winning selection: + (odds - 1) * stake
 * - BACK bet on losing selection: - stake
 * - LAY bet on winning selection: - (odds - 1) * stake
 * - LAY bet on losing selection: + stake
 * 
 * @param bets - Array of ALL bets (will be filtered to Match Odds only)
 * @param marketId - Market ID to filter bets (optional, if provided only includes bets for this market)
 * @returns Match Odds position or null if no Match Odds bets found
 */
export function calculateMatchOddsPosition(
  bets: BetForPosition[] | Bet[],
  marketId?: string,
): MatchOddsPosition | null {
  // Filter to ONLY Match Odds bets
  const matchOddsBets = bets.filter((bet) => {
    const betGtype = (bet.gtype || '').toLowerCase();
    const isMatchOdds = betGtype === 'matchodds' || betGtype === 'match';
    
    // If marketId provided, must match
    if (marketId && bet.marketId !== marketId) {
      return false;
    }
    
    return isMatchOdds && bet.status === 'PENDING';
  });

  if (matchOddsBets.length === 0) {
    return null;
  }

  // Get unique marketId (should be same for all bets if filtered)
  const firstMarketId = matchOddsBets[0]?.marketId;
  if (!firstMarketId) {
    return null;
  }

  // Get all unique selectionIds from bets
  const selectionIds = Array.from(
    new Set(
      matchOddsBets
        .map((bet) => bet.selectionId)
        .filter((id): id is number => id !== null && id !== undefined)
        .map((id) => String(id))
    )
  );

  if (selectionIds.length === 0) {
    return null;
  }

  // Initialize positions for all selections
  const positions: Record<string, { profit: number; loss: number }> = {};

  // ✅ Calculate P/L per outcome using pre-calculated winAmount/lossAmount
  // For each outcome: sum all winAmount (if this outcome wins) and lossAmount (if this outcome loses)
  for (const outcomeSelection of selectionIds) {
    let totalProfit = 0; // Sum of all winAmount when this selection wins
    let totalLoss = 0;   // Sum of all lossAmount when this selection loses

    for (const bet of matchOddsBets) {
      // Skip bets with invalid selectionId
      if (bet.selectionId === null || bet.selectionId === undefined) {
        continue;
      }

      const betSelection = String(bet.selectionId);
      const betType = bet.betType?.toUpperCase();
      const winAmount = bet.winAmount ?? 0;
      const lossAmount = bet.lossAmount ?? 0;

      // Skip invalid bets
      if (!betType || (betType !== 'BACK' && betType !== 'LAY')) {
        continue;
      }

      // Use pre-calculated winAmount/lossAmount if available, otherwise calculate from odds
      let betWinAmount = winAmount;
      let betLossAmount = lossAmount;

      // Fallback to calculation only if winAmount/lossAmount not provided
      if (betWinAmount === 0 && betLossAmount === 0) {
        const odds = bet.betRate ?? bet.odds ?? 0;
        const stake = bet.betValue ?? bet.amount ?? 0;
        
        if (odds > 0 && stake > 0) {
          if (betType === 'BACK') {
            betWinAmount = (odds - 1) * stake;
            betLossAmount = stake;
          } else if (betType === 'LAY') {
            betWinAmount = stake;
            betLossAmount = (odds - 1) * stake;
          }
        }
      }

      if (betSelection === outcomeSelection) {
        // Bet is on this outcome
        // If this outcome wins: we get winAmount (positive)
        // If this outcome loses: we lose lossAmount (negative)
        totalProfit += betWinAmount;
        totalLoss -= betLossAmount; // Negative because we lose money
      } else {
        // Bet is on another outcome
        // If THIS outcome wins (bet outcome loses): we lose lossAmount (negative)
        // If THIS outcome loses (bet outcome wins): we get winAmount (positive)
        totalProfit -= betLossAmount;
        totalLoss += betWinAmount;
      }
    }

    // ✅ UI FIX: Collapse to net exposure for proper hedging display
    // net = profit + loss (profit is positive, loss is negative, so net = profit - |loss|)
    const net = totalProfit + totalLoss;
    
    // Return win/lose format for UI preview
    // win = net > 0 ? net : 0 (if net positive, show as win)
    // lose = net < 0 ? abs(net) : 0 (if net negative, show as loss)
    positions[outcomeSelection] = {
      profit: net > 0 ? net : 0,
      loss: net < 0 ? Math.abs(net) : 0,
    };
  }

  return {
    marketId: firstMarketId,
    positions,
  };
}

/**
 * ✅ PURE FUNCTION: Calculate Fancy Position
 * 
 * Fancy Position Rules:
 * - Aggregates ONLY bets with gtype='fancy'
 * - Grouped by (eventId, selectionId) = fancyId
 * - Position: { YES: number, NO: number }
 *   - YES: Net position for BACK/YES bets (positive = profit, negative = loss)
 *   - NO: Net position for LAY/NO bets (positive = profit, negative = loss)
 * - Fancy liability = stake (for both BACK and LAY)
 * - BACK/YES: +stake if wins, -stake if loses
 * - LAY/NO: -stake if wins, +stake if loses
 * 
 * @param bets - Array of ALL bets (will be filtered to Fancy only)
 * @returns Array of Fancy positions grouped by fancyId
 */
export function calculateFancyPosition(bets: BetForPosition[] | Bet[]): FancyPosition[] {
  // Filter to ONLY Fancy bets
  const fancyBets = bets.filter((bet) => {
    const betGtype = (bet.gtype || '').toLowerCase();
    return betGtype === 'fancy' && bet.status === 'PENDING' && bet.eventId && bet.selectionId !== null && bet.selectionId !== undefined;
  });

  if (fancyBets.length === 0) {
    return [];
  }

  // Group bets by fancyId (eventId_selectionId)
  const betsByFancyId = new Map<string, (BetForPosition | Bet)[]>();
  for (const bet of fancyBets) {
    const fancyId = `${bet.eventId}_${bet.selectionId}`;
    if (!betsByFancyId.has(fancyId)) {
      betsByFancyId.set(fancyId, []);
    }
    betsByFancyId.get(fancyId)!.push(bet);
  }

  // Calculate position for each fancy
  const fancyPositions: FancyPosition[] = [];

  for (const [fancyId, fancyBetsGroup] of betsByFancyId.entries()) {
    let yesPosition = 0; // BACK/YES bets
    let noPosition = 0;  // LAY/NO bets

    for (const bet of fancyBetsGroup) {
      const betType = bet.betType?.toUpperCase() || '';
      const stake = bet.betValue ?? bet.amount ?? 0;

      if (stake <= 0) continue;

      // FANCY: liability = stake for both BACK and LAY
      if (betType === 'BACK' || betType === 'YES') {
        // BACK/YES: If wins, get stake back + profit = stake, if loses = -stake
        // Net position: positive means profit potential, negative means loss potential
        yesPosition += stake; // Assuming win scenario
        // For loss scenario, we'd subtract stake, but we track net
      } else if (betType === 'LAY' || betType === 'NO') {
        // LAY/NO: If wins, lose stake = -stake, if loses, profit = +stake
        noPosition += stake; // Assuming win scenario (we profit if they lose)
      }
    }

    // Calculate net positions
    // YES position: sum of all BACK/YES stakes (what we stand to win/lose)
    // NO position: sum of all LAY/NO stakes (what we stand to win/lose)
    // For display: YES shows net BACK position, NO shows net LAY position
    
    // Refined calculation: YES = net BACK position, NO = net LAY position
    let netYes = 0;
    let netNo = 0;

    for (const bet of fancyBetsGroup) {
      const betType = bet.betType?.toUpperCase() || '';
      const stake = bet.betValue ?? bet.amount ?? 0;

      if (stake <= 0) continue;

      if (betType === 'BACK' || betType === 'YES') {
        netYes += stake; // BACK increases YES position
      } else if (betType === 'LAY' || betType === 'NO') {
        netNo += stake; // LAY increases NO position
      }
    }

    // Net position: positive = net BACK (if YES wins, we profit), negative = net LAY (if NO wins, we profit)
    // For fancy display:
    // YES = netYes - netNo (if positive, net BACK position)
    // NO = netNo - netYes (if positive, net LAY position)
    
    fancyPositions.push({
      fancyId,
      name: fancyBetsGroup[0]?.betName || undefined,
      positions: {
        YES: netYes - netNo, // Net position on YES side
        NO: netNo - netYes,  // Net position on NO side
      },
    });
  }

  return fancyPositions;
}

/**
 * ✅ PURE FUNCTION: Calculate Bookmaker Position (UI FIX)
 * 
 * Bookmaker Position Rules (same as Match Odds):
 * - Aggregates ONLY bets with gtype='bookmaker' or gtype starts with 'match' (match1, match2, etc.) but NOT 'matchodds' or 'match'
 * - For EACH runner: Calculate P/L if this runner wins
 * - Apply BACK and LAY impact
 * - Apply opposite impact for other runners
 * - Collapse to net exposure
 * - Return per selection: { profit, loss }
 * 
 * Exchange-standard calculation:
 * - For each outcome: Calculate total P/L if that outcome wins
 * - BACK bet on winning selection: + (odds - 1) * stake
 * - BACK bet on losing selection: - stake
 * - LAY bet on winning selection: - (odds - 1) * stake
 * - LAY bet on losing selection: + stake
 * 
 * @param bets - Array of ALL bets (will be filtered to Bookmaker only)
 * @param marketId - Market ID to filter bets (optional, if provided only includes bets for this market)
 * @returns Bookmaker position or null if no Bookmaker bets found
 */
export function calculateBookmakerPosition(
  bets: BetForPosition[] | Bet[],
  marketId?: string,
): BookmakerPosition | null {
  // Filter to ONLY Bookmaker bets
  const bookmakerBets = bets.filter((bet) => {
    const betGtype = (bet.gtype || '').toLowerCase();
    const isBookmaker = betGtype === 'bookmaker' ||
      (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
    
    // If marketId provided, must match
    if (marketId && bet.marketId !== marketId) {
      return false;
    }
    
    return isBookmaker && bet.status === 'PENDING';
  });

  if (bookmakerBets.length === 0) {
    return null;
  }

  // Get unique marketId (should be same for all bets if filtered)
  const firstMarketId = bookmakerBets[0]?.marketId;
  if (!firstMarketId) {
    return null;
  }

  // Get all unique selectionIds from bets
  const selectionIds = Array.from(
    new Set(
      bookmakerBets
        .map((bet) => bet.selectionId)
        .filter((id): id is number => id !== null && id !== undefined)
        .map((id) => String(id))
    )
  );

  if (selectionIds.length === 0) {
    return null;
  }

  // Initialize positions for all selections
  const positions: Record<string, { profit: number; loss: number }> = {};

  // ✅ Calculate P/L per outcome (same logic as Match Odds)
  for (const outcomeSelection of selectionIds) {
    let totalProfit = 0; // Sum of all winAmount when this selection wins
    let totalLoss = 0;   // Sum of all lossAmount when this selection loses

    for (const bet of bookmakerBets) {
      // Skip bets with invalid selectionId
      if (bet.selectionId === null || bet.selectionId === undefined) {
        continue;
      }

      const betSelection = String(bet.selectionId);
      const betType = bet.betType?.toUpperCase();
      const winAmount = bet.winAmount ?? 0;
      const lossAmount = bet.lossAmount ?? 0;

      // Skip invalid bets
      if (!betType || (betType !== 'BACK' && betType !== 'LAY')) {
        continue;
      }

      // Use pre-calculated winAmount/lossAmount if available, otherwise calculate from odds
      let betWinAmount = winAmount;
      let betLossAmount = lossAmount;

      // Fallback to calculation only if winAmount/lossAmount not provided
      if (betWinAmount === 0 && betLossAmount === 0) {
        const odds = bet.betRate ?? bet.odds ?? 0;
        const stake = bet.betValue ?? bet.amount ?? 0;
        
        if (odds > 0 && stake > 0) {
          if (betType === 'BACK') {
            betWinAmount = (odds - 1) * stake;
            betLossAmount = stake;
          } else if (betType === 'LAY') {
            betWinAmount = stake;
            betLossAmount = (odds - 1) * stake;
          }
        }
      }

      if (betSelection === outcomeSelection) {
        // Bet is on this outcome
        // If this outcome wins: we get winAmount (positive)
        // If this outcome loses: we lose lossAmount (negative)
        totalProfit += betWinAmount;
        totalLoss -= betLossAmount; // Negative because we lose money
      } else {
        // Bet is on another outcome
        // If THIS outcome wins (bet outcome loses): we lose lossAmount (negative)
        // If THIS outcome loses (bet outcome wins): we get winAmount (positive)
        totalProfit -= betLossAmount;
        totalLoss += betWinAmount;
      }
    }

    // ✅ UI FIX: Collapse to net exposure for proper hedging display
    const net = totalProfit + totalLoss;
    
    // Return win/lose format for UI preview
    positions[outcomeSelection] = {
      profit: net > 0 ? net : 0,
      loss: net < 0 ? Math.abs(net) : 0,
    };
  }

  return {
    marketId: firstMarketId,
    positions,
  };
}

/**
 * ✅ PURE FUNCTION: Calculate All Positions
 * 
 * Calculates positions for all market types from open bets.
 * Markets are completely isolated - no mixing.
 * 
 * @param bets - Array of ALL open bets
 * @returns All positions grouped by market type
 */
export function calculateAllPositions(bets: BetForPosition[] | Bet[]): AllPositions {
  const result: AllPositions = {};

  // Calculate Match Odds position (aggregate all Match Odds markets)
  // Note: If multiple Match Odds markets exist, we need to group by marketId
  const matchOddsBetsByMarket = new Map<string, (BetForPosition | Bet)[]>();
  for (const bet of bets) {
    const betGtype = (bet.gtype || '').toLowerCase();
    if ((betGtype === 'matchodds' || betGtype === 'match') && bet.marketId) {
      if (!matchOddsBetsByMarket.has(bet.marketId)) {
        matchOddsBetsByMarket.set(bet.marketId, []);
      }
      matchOddsBetsByMarket.get(bet.marketId)!.push(bet);
    }
  }

  // For now, return first Match Odds market (can be extended to support multiple)
  // TODO: If frontend needs multiple Match Odds markets, extend to return array
  if (matchOddsBetsByMarket.size > 0) {
    const firstMarketId = Array.from(matchOddsBetsByMarket.keys())[0];
    const matchOddsPosition = calculateMatchOddsPosition(
      matchOddsBetsByMarket.get(firstMarketId)!,
      firstMarketId,
    );
    if (matchOddsPosition) {
      result.matchOdds = matchOddsPosition;
    }
  }

  // Calculate Fancy positions (all fancy bets grouped by fancyId)
  const fancyPositions = calculateFancyPosition(bets);
  if (fancyPositions.length > 0) {
    result.fancy = fancyPositions;
  }

  // Calculate Bookmaker position (aggregate all Bookmaker markets)
  const bookmakerBetsByMarket = new Map<string, (BetForPosition | Bet)[]>();
  for (const bet of bets) {
    const betGtype = (bet.gtype || '').toLowerCase();
    const isBookmaker = betGtype === 'bookmaker' ||
      (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
    if (isBookmaker && bet.marketId) {
      if (!bookmakerBetsByMarket.has(bet.marketId)) {
        bookmakerBetsByMarket.set(bet.marketId, []);
      }
      bookmakerBetsByMarket.get(bet.marketId)!.push(bet);
    }
  }

  // For now, return first Bookmaker market (can be extended to support multiple)
  if (bookmakerBetsByMarket.size > 0) {
    const firstMarketId = Array.from(bookmakerBetsByMarket.keys())[0];
    const bookmakerPosition = calculateBookmakerPosition(
      bookmakerBetsByMarket.get(firstMarketId)!,
      firstMarketId,
    );
    if (bookmakerPosition) {
      result.bookmaker = bookmakerPosition;
    }
  }

  return result;
}

/**
 * @deprecated Use calculateMatchOddsPosition, calculateFancyPosition, or calculateBookmakerPosition instead
 * This function is kept for backward compatibility but does NOT enforce market isolation
 */
export function calculatePositions(
  selections: string[],
  bets: BetForPosition[] | Bet[],
): Record<string, { win: number; lose: number }> {
  // Filter to only PENDING bets
  const pendingBets = bets.filter((bet) => bet.status === 'PENDING');

  const positions: Record<string, { win: number; lose: number }> = {};

  // Initialize all selections
  for (const s of selections) {
    positions[s] = { win: 0, lose: 0 };
  }

  // Calculate position for each bet
  for (const bet of pendingBets) {
    if (bet.selectionId === null || bet.selectionId === undefined) {
      continue;
    }

    const betSelectionId = String(bet.selectionId);
    const betType = bet.betType?.toUpperCase();
    const odds = bet.betRate ?? bet.odds ?? 0;
    const stake = bet.betValue ?? bet.amount ?? 0;

    if (!betType || (betType !== 'BACK' && betType !== 'LAY') || odds <= 0 || stake <= 0) {
      continue;
    }

    for (const selection of selections) {
      const isBetOnThisSelection = selection === betSelectionId;

      if (betType === 'BACK') {
        if (isBetOnThisSelection) {
          positions[selection].win += (odds - 1) * stake;
          positions[selection].lose += -stake;
        } else {
          positions[selection].win += -stake;
          positions[selection].lose += (odds - 1) * stake;
        }
      }

      if (betType === 'LAY') {
        if (isBetOnThisSelection) {
          positions[selection].win += -(odds - 1) * stake;
          positions[selection].lose += stake;
        } else {
          positions[selection].win += stake;
          positions[selection].lose += -(odds - 1) * stake;
        }
      }
    }
  }

  return positions;
}

@Injectable()
export class PositionService {
  /**
   * Calculate positions for selections based on bets (DEPRECATED - use market-specific functions)
   * 
   * @param selections - Array of selection IDs (as strings)
   * @param bets - Array of Bet objects from database
   * @returns Record mapping selection ID to { win: number, lose: number }
   */
  calculatePositions(selections: string[], bets: Bet[]): Record<string, { win: number; lose: number }> {
    return calculatePositions(selections, bets);
  }

  /**
   * Calculate Match Odds position
   */
  calculateMatchOddsPosition(bets: BetForPosition[] | Bet[], marketId?: string): MatchOddsPosition | null {
    return calculateMatchOddsPosition(bets, marketId);
  }

  /**
   * Calculate Fancy position
   */
  calculateFancyPosition(bets: BetForPosition[] | Bet[]): FancyPosition[] {
    return calculateFancyPosition(bets);
  }

  /**
   * Calculate Bookmaker position
   */
  calculateBookmakerPosition(bets: BetForPosition[] | Bet[], marketId?: string): BookmakerPosition | null {
    return calculateBookmakerPosition(bets, marketId);
  }

  /**
   * Calculate all positions (all market types)
   */
  calculateAllPositions(bets: BetForPosition[] | Bet[]): AllPositions {
    return calculateAllPositions(bets);
  }

  /**
   * Calculate positions with typed bet input (for testing or external use)
   * 
   * @param selections - Array of selection IDs (as strings)
   * @param bets - Array of BetInput objects
   * @returns Record mapping selection ID to { win: number, lose: number }
   */
  calculatePositionsFromInput(
    selections: string[],
    bets: BetInput[],
  ): Record<string, { win: number; lose: number }> {
    const positions: Record<string, { win: number; lose: number }> = {};

    // Initialize all selections to { win: 0, lose: 0 }
    for (const s of selections) {
      positions[s] = { win: 0, lose: 0 };
    }

    // Calculate position for each bet
    for (const bet of bets) {
      const betSelectionId = String(bet.selectionId);

      // Calculate position impact for the bet's selection
      for (const selection of selections) {
        const isWinOutcome = selection === betSelectionId;

        if (bet.betType === 'BACK') {
          if (isWinOutcome) {
            positions[selection].win += (bet.odds - 1) * bet.stake;
            positions[selection].lose += -bet.stake;
          }
        }

        if (bet.betType === 'LAY') {
          if (isWinOutcome) {
            positions[selection].win += -(bet.odds - 1) * bet.stake;
            positions[selection].lose += bet.stake;
          }
        }
      }
    }

    return positions;
  }
}
