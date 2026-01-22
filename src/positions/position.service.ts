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
 * Match Odds Position Result (Exchange Standard)
 * 
 * Returns NET P/L if each runner wins.
 * Values can be positive (profit) or negative (loss).
 */
export interface MatchOddsPosition {
  marketId: string;
  runners: Record<string, { net: number }>; // selectionId -> { net P/L if this runner wins }
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
 * Bookmaker Position Result (Exchange Standard)
 * 
 * Returns NET P/L if each runner wins.
 * Values can be positive (profit) or negative (loss).
 */
export interface BookmakerPosition {
  marketId: string;
  runners: Record<string, { net: number }>; // selectionId -> { net P/L if this runner wins }
}

/**
 * Complete Position Result
 * 
 * Supports multiple Match Odds and Bookmaker markets.
 */
export interface AllPositions {
  matchOdds?: MatchOddsPosition[]; // Array to support multiple Match Odds markets
  fancy?: FancyPosition[];
  bookmaker?: BookmakerPosition[]; // Array to support multiple Bookmaker markets
}

/**
 * ✅ PURE FUNCTION: Calculate Match Odds Position (Exchange Standard)
 * 
 * Exchange Standard Definition:
 * - For EACH runner in the market, calculate NET P/L **IF THAT RUNNER WINS**
 * - Return ONE value per runner (NOT profit + loss separately)
 * - Values can be POSITIVE (profit) or NEGATIVE (loss)
 * - MUST include ALL runners, even if they have no direct bets
 * 
 * Formula per bet:
 * BACK bet:
 *   - If selected runner wins  → +(odds - 1) * stake
 *   - If selected runner loses → -stake
 * 
 * LAY bet:
 *   - If selected runner wins  → -(odds - 1) * stake
 *   - If selected runner loses → +stake
 * 
 * For every runner:
 * - Sum impact of ALL bets (including opposite-runner effects)
 * - Final value can be POSITIVE or NEGATIVE (hedged/loss scenarios)
 * - Runners with no direct bets still get position from opposite-runner bets
 * 
 * @param bets - Array of ALL bets (will be filtered to Match Odds only)
 * @param marketId - Market ID (required for runner list)
 * @param marketSelections - Array of ALL runner IDs in the market (REQUIRED)
 * @returns Match Odds position or null if no Match Odds bets found or marketSelections empty
 */
export function calculateMatchOddsPosition(
  bets: BetForPosition[] | Bet[],
  marketId: string,
  marketSelections: string[],
): MatchOddsPosition | null {
  // ✅ CRITICAL: marketSelections is REQUIRED - contains ALL runners in market
  if (!marketSelections || marketSelections.length === 0) {
    return null;
  }

  if (!marketId) {
    return null;
  }

  // Filter to ONLY Match Odds bets for this market
  const matchOddsBets = bets.filter((bet) => {
    const betGtype = (bet.gtype || '').toLowerCase();
    const isMatchOdds = betGtype === 'matchodds' || betGtype === 'match';
    // ✅ CRITICAL: Include ALL bets regardless of status (but filter by marketId)
    // Status filtering should be done at query level, not here
    return isMatchOdds && bet.marketId === marketId;
  });

  // ✅ CRITICAL: Return position even if no bets (all runners will have net = 0)
  // This ensures ALL runners are included in response

  // Initialize positions for ALL runners in market
  const runners: Record<string, { net: number }> = {};

  // ✅ Exchange Standard: Calculate NET P/L for EACH runner in market
  // Loop through ALL runners (from marketSelections), not just runners with bets
  for (const runnerSelectionId of marketSelections) {
    let netPnL = 0; // Net P/L if THIS runner wins (can be positive or negative)

    // Calculate impact of ALL bets on this runner
    for (const bet of matchOddsBets) {
      // Skip bets with invalid selectionId
      if (bet.selectionId === null || bet.selectionId === undefined) {
        continue;
      }

      const betSelection = String(bet.selectionId);
      const betType = bet.betType?.toUpperCase();
      const odds = bet.betRate ?? bet.odds ?? 0;
      const stake = bet.betValue ?? bet.amount ?? 0;

      // Skip invalid bets
      if (!betType || (betType !== 'BACK' && betType !== 'LAY') || odds <= 0 || stake <= 0) {
        continue;
      }

      if (betSelection === runnerSelectionId) {
        // Bet is on THIS runner
        if (betType === 'BACK') {
          // BACK on winning runner: profit = (odds - 1) * stake
          netPnL += (odds - 1) * stake;
        } else if (betType === 'LAY') {
          // LAY on winning runner: loss = -(odds - 1) * stake
          netPnL -= (odds - 1) * stake;
        }
      } else {
        // Bet is on ANOTHER runner (opposite effect)
        if (betType === 'BACK') {
          // BACK on losing runner: loss = -stake
          netPnL -= stake;
        } else if (betType === 'LAY') {
          // LAY on losing runner: profit = +stake
          netPnL += stake;
        }
      }
    }

    // ✅ Exchange Standard: Return net P/L (can be negative for hedged/loss scenarios)
    // Include ALL runners, even if netPnL = 0 (no direct bets)
    // Round to 2 decimals to avoid floating point artifacts (e.g., 319.9999999999 → 320.00)
    runners[runnerSelectionId] = {
      net: Math.round(netPnL * 100) / 100, // Round to 2 decimals, negative values are valid
    };
  }

  return {
    marketId,
    runners,
  };
}

/**
 * ✅ PURE FUNCTION: Calculate Fancy Position (Exchange Standard)
 * 
 * Fancy Position Rules:
 * - Aggregates ONLY bets with gtype='fancy'
 * - Grouped by (eventId, selectionId) = fancyId
 * - Liability = stake (for both BACK and LAY)
 * 
 * Exchange Standard Calculation:
 * YES (BACK):
 *   - If YES wins → +stake (for each YES bet)
 *   - If YES loses (NO wins) → -stake (for each YES bet)
 * 
 * NO (LAY):
 *   - If NO wins (YES loses) → +stake (for each NO bet)
 *   - If NO loses (YES wins) → -stake (for each NO bet)
 * 
 * Position Calculation:
 * - YES position = sum(YES stakes) - sum(NO stakes)
 *   (Net P/L if YES wins: YES bets profit, NO bets lose)
 * - NO position = sum(NO stakes) - sum(YES stakes)
 *   (Net P/L if NO wins: NO bets profit, YES bets lose)
 * 
 * Values can be POSITIVE or NEGATIVE (hedged scenarios).
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
    // ✅ Exchange Standard: Calculate net P/L for YES and NO outcomes
    let sumYesStakes = 0; // Sum of all YES/BACK bet stakes
    let sumNoStakes = 0;  // Sum of all NO/LAY bet stakes

    for (const bet of fancyBetsGroup) {
      const betType = bet.betType?.toUpperCase() || '';
      const stake = bet.betValue ?? bet.amount ?? 0;

      if (stake <= 0) continue;

      if (betType === 'BACK' || betType === 'YES') {
        sumYesStakes += stake;
      } else if (betType === 'LAY' || betType === 'NO') {
        sumNoStakes += stake;
      }
    }

    // ✅ Exchange Standard Calculation:
    // YES position = Net P/L if YES wins
    //   = sum(YES stakes) - sum(NO stakes)
    //   (YES bets profit +stake each, NO bets lose -stake each)
    // 
    // NO position = Net P/L if NO wins
    //   = sum(NO stakes) - sum(YES stakes)
    //   (NO bets profit +stake each, YES bets lose -stake each)
    // 
    // Values can be NEGATIVE (hedged scenarios are valid)
    const yesPosition = sumYesStakes - sumNoStakes;
    const noPosition = sumNoStakes - sumYesStakes;
    
    fancyPositions.push({
      fancyId,
      name: fancyBetsGroup[0]?.betName || undefined,
      positions: {
        YES: yesPosition, // Net P/L if YES wins (can be negative)
        NO: noPosition,   // Net P/L if NO wins (can be negative)
      },
    });
  }

  return fancyPositions;
}

/**
 * ✅ PURE FUNCTION: Calculate Bookmaker Position (Exchange Standard)
 * 
 * Exchange Standard Definition (same as Match Odds):
 * - For EACH runner in the market, calculate NET P/L **IF THAT RUNNER WINS**
 * - Return ONE value per runner (NOT profit + loss separately)
 * - Values can be POSITIVE (profit) or NEGATIVE (loss)
 * - MUST include ALL runners, even if they have no direct bets
 * 
 * Formula per bet:
 * BACK bet:
 *   - If selected runner wins  → +(odds - 1) * stake
 *   - If selected runner loses → -stake
 * 
 * LAY bet:
 *   - If selected runner wins  → -(odds - 1) * stake
 *   - If selected runner loses → +stake
 * 
 * For every runner:
 * - Sum impact of ALL bets (including opposite-runner effects)
 * - Final value can be POSITIVE or NEGATIVE (hedged/loss scenarios)
 * - Runners with no direct bets still get position from opposite-runner bets
 * 
 * @param bets - Array of ALL bets (will be filtered to Bookmaker only)
 * @param marketId - Market ID (required for runner list)
 * @param marketSelections - Array of ALL runner IDs in the market (REQUIRED)
 * @returns Bookmaker position or null if no Bookmaker bets found or marketSelections empty
 */
export function calculateBookmakerPosition(
  bets: BetForPosition[] | Bet[],
  marketId: string,
  marketSelections: string[],
): BookmakerPosition | null {
  // ✅ CRITICAL: marketSelections is REQUIRED - contains ALL runners in market
  if (!marketSelections || marketSelections.length === 0) {
    return null;
  }

  if (!marketId) {
    return null;
  }

  // Filter to ONLY Bookmaker bets for this market
  const bookmakerBets = bets.filter((bet) => {
    const betGtype = (bet.gtype || '').toLowerCase();
    const isBookmaker = betGtype === 'bookmaker' ||
      (betGtype.startsWith('match') && betGtype !== 'match' && betGtype !== 'matchodds');
    return isBookmaker && bet.marketId === marketId && bet.status === 'PENDING';
  });

  // ✅ CRITICAL: Return position even if no bets (all runners will have net = 0)
  // This ensures ALL runners are included in response

  // Initialize positions for ALL runners in market
  const runners: Record<string, { net: number }> = {};

  // ✅ Exchange Standard: Calculate NET P/L for EACH runner in market
  // Loop through ALL runners (from marketSelections), not just runners with bets
  for (const runnerSelectionId of marketSelections) {
    let netPnL = 0; // Net P/L if THIS runner wins (can be positive or negative)

    // Calculate impact of ALL bets on this runner
    for (const bet of bookmakerBets) {
      // Skip bets with invalid selectionId
      if (bet.selectionId === null || bet.selectionId === undefined) {
        continue;
      }

      const betSelection = String(bet.selectionId);
      const betType = bet.betType?.toUpperCase();
      const odds = bet.betRate ?? bet.odds ?? 0;
      const stake = bet.betValue ?? bet.amount ?? 0;

      // Skip invalid bets
      if (!betType || (betType !== 'BACK' && betType !== 'LAY') || odds <= 0 || stake <= 0) {
        continue;
      }

      if (betSelection === runnerSelectionId) {
        // Bet is on THIS runner
        if (betType === 'BACK') {
          // BACK on winning runner: profit = (odds - 1) * stake
          netPnL += (odds - 1) * stake;
        } else if (betType === 'LAY') {
          // LAY on winning runner: loss = -(odds - 1) * stake
          netPnL -= (odds - 1) * stake;
        }
      } else {
        // Bet is on ANOTHER runner (opposite effect)
        if (betType === 'BACK') {
          // BACK on losing runner: loss = -stake
          netPnL -= stake;
        } else if (betType === 'LAY') {
          // LAY on losing runner: profit = +stake
          netPnL += stake;
        }
      }
    }

    // ✅ Exchange Standard: Return net P/L (can be negative for hedged/loss scenarios)
    // Include ALL runners, even if netPnL = 0 (no direct bets)
    // Round to 2 decimals to avoid floating point artifacts (e.g., 319.9999999999 → 320.00)
    runners[runnerSelectionId] = {
      net: Math.round(netPnL * 100) / 100, // Round to 2 decimals, negative values are valid
    };
  }

  return {
    marketId,
    runners,
  };
}

/**
 * ✅ PURE FUNCTION: Calculate All Positions
 * 
 * Calculates positions for all market types from open bets.
 * Markets are completely isolated - no mixing.
 * 
 * ⚠️ NOTE: Match Odds and Bookmaker positions require marketSelections.
 * If not provided, those markets will be skipped.
 * 
 * @param bets - Array of ALL open bets
 * @param marketSelectionsMap - Optional map of marketId -> runner IDs array
 * @returns All positions grouped by market type
 */
export function calculateAllPositions(
  bets: BetForPosition[] | Bet[],
  marketSelectionsMap?: Map<string, string[]>,
): AllPositions {
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

  // ✅ Calculate positions for ALL Match Odds markets (not just the first one)
  const matchOddsPositions: MatchOddsPosition[] = [];
  
  for (const [marketId, marketBets] of matchOddsBetsByMarket.entries()) {
    const marketSelections = marketSelectionsMap?.get(marketId);
    
    // ✅ CRITICAL: Match Odds runners MUST come from Detail Match API, NOT from bets
    // This ensures ALL runners are included even if they have no bets
    // If marketSelections not provided, skip this market (don't derive from bets)
    if (!marketSelections || marketSelections.length === 0) {
      // Skip this market - runners must come from API
      continue;
    }
    
    const matchOddsPosition = calculateMatchOddsPosition(
      marketBets,
      marketId,
      marketSelections,
    );
    if (matchOddsPosition) {
      matchOddsPositions.push(matchOddsPosition);
    }
  }
  
  if (matchOddsPositions.length > 0) {
    result.matchOdds = matchOddsPositions;
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

  // ✅ Calculate positions for ALL Bookmaker markets (not just the first one)
  const bookmakerPositions: BookmakerPosition[] = [];
  
  for (const [marketId, marketBets] of bookmakerBetsByMarket.entries()) {
    const marketSelections = marketSelectionsMap?.get(marketId);
    
    // ✅ CRITICAL: If marketSelections not provided, derive from bets as fallback
    // This ensures newly placed bets are included even if not in marketSelectionsMap
    let finalMarketSelections = marketSelections;
    if (!finalMarketSelections || finalMarketSelections.length === 0) {
      // Derive from bets as fallback
      finalMarketSelections = Array.from(
        new Set(
          marketBets
            .map((bet) => bet.selectionId)
            .filter((id): id is number => id !== null && id !== undefined)
            .map((id) => String(id))
        )
      );
    }
    
    if (finalMarketSelections && finalMarketSelections.length > 0) {
      const bookmakerPosition = calculateBookmakerPosition(
        marketBets,
        marketId,
        finalMarketSelections,
      );
      if (bookmakerPosition) {
        bookmakerPositions.push(bookmakerPosition);
      }
    }
  }
  
  if (bookmakerPositions.length > 0) {
    result.bookmaker = bookmakerPositions;
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
   * 
   * @param bets - Array of bets
   * @param marketId - Market ID (required)
   * @param marketSelections - Array of ALL runner IDs in the market (required)
   */
  calculateMatchOddsPosition(
    bets: BetForPosition[] | Bet[],
    marketId: string,
    marketSelections: string[],
  ): MatchOddsPosition | null {
    return calculateMatchOddsPosition(bets, marketId, marketSelections);
  }

  /**
   * Calculate Fancy position
   */
  calculateFancyPosition(bets: BetForPosition[] | Bet[]): FancyPosition[] {
    return calculateFancyPosition(bets);
  }

  /**
   * Calculate Bookmaker position
   * 
   * @param bets - Array of bets
   * @param marketId - Market ID (required)
   * @param marketSelections - Array of ALL runner IDs in the market (required)
   */
  calculateBookmakerPosition(
    bets: BetForPosition[] | Bet[],
    marketId: string,
    marketSelections: string[],
  ): BookmakerPosition | null {
    return calculateBookmakerPosition(bets, marketId, marketSelections);
  }

  /**
   * Calculate all positions (all market types)
   * 
   * @param bets - Array of bets
   * @param marketSelectionsMap - Optional map of marketId -> runner IDs array
   */
  calculateAllPositions(
    bets: BetForPosition[] | Bet[],
    marketSelectionsMap?: Map<string, string[]>,
  ): AllPositions {
    return calculateAllPositions(bets, marketSelectionsMap);
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
