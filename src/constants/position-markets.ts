/**
 * Markets that support Position tracking for UI preview
 * 
 * IMPORTANT:
 * - Position tracking is ONLY for UI preview (temporary)
 * - Positions are cleared immediately after settlement
 * - Only MATCH_ODDS and BOOKMAKER markets use positions
 * - FANCY and other markets do NOT use positions
 */
export const POSITION_MARKETS = [
  'MATCH_ODDS',
  'BOOKMAKER',
] as const;

/**
 * Check if a market type supports position tracking
 */
export function isPositionMarket(marketType: string | null | undefined): boolean {
  if (!marketType) return false;
  return POSITION_MARKETS.includes(marketType.toUpperCase() as any);
}

