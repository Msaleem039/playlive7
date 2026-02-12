import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PositionService, calculateMatchOddsPosition, calculateFancyPosition, MatchOddsPosition, FancyPosition, BetForPosition } from '../positions/position.service';
import { AggregatorService } from '../cricketid/aggregator.service';
import { BetStatus, UserRole } from '@prisma/client';

/**
 * Agent Match Book Service
 * 
 * Calculates aggregated positions for an Agent based on all their clients' pending bets.
 * Agent position is the inverse of total client positions.
 * 
 * 🚨 CRITICAL RULES:
 * - Only uses PENDING bets
 * - No wallet mutations (preview only)
 * - Reuses existing position calculation logic
 * - Markets are isolated (Match Odds, Fancy)
 */

export interface BetDetail {
  id: string;
  eventId: string | null;
  marketId: string | null;
  selectionId: number | null;
  betType: string | null;
  betName: string | null;
  gtype: string | null;
  amount: number;
  odds: number;
  betValue: number | null;
  winAmount: number | null;
  lossAmount: number | null;
  status: string;
  createdAt: Date;
  username: string | null;
  userName: string | null;
}

export interface ClientPosition {
  clientId: string;
  clientName: string | null;
  clientUsername: string | null;
  matchOddsPosition: MatchOddsPosition | null;
  fancyPosition: FancyPosition[];
  totalIfWin: number;
  totalIfLose: number;
  bets: BetDetail[];
}

export interface MatchData {
  eventId: string;
  matchTitle: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: Date | null;
  totalBets: number;
  totalAmount: number;
  agentTotalIfWin: number;
  agentTotalIfLose: number;
  agentTotalFancyPosition: number;
  agentTotalMatchOddsPosition: number;
  clients: ClientPosition[];
}

export interface AgentMatchBookResult {
  agentId: string;
  totalIfWin: number;
  totalIfLose: number;
  totalFancyPosition: number;
  totalMatchOddsPosition: number;
  totalBets: number;
  totalClients: number;
  totalMatches: number;
  matches: MatchData[];
}

@Injectable()
export class AgentMatchBookService {
  private readonly logger = new Logger(AgentMatchBookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly positionService: PositionService,
    private readonly aggregatorService: AggregatorService,
  ) {}

  /**
   * Get Agent Match Book
   * 
   * Fetches all pending bets from all clients under the agent,
   * calculates positions per client, and aggregates for the agent.
   * 
   * @param agentId - Agent user ID
   * @param eventId - Optional event ID filter
   * @param marketId - Optional market ID filter
   * @param marketType - Optional market type filter ('match-odds' | 'fancy')
   */
  async getAgentMatchBook(
    agentId: string,
    eventId?: string,
    marketId?: string,
    marketType?: string,
  ): Promise<AgentMatchBookResult> {
    // 1️⃣ Fetch all clients under this agent
    const clients = await this.prisma.user.findMany({
      where: {
        parentId: agentId,
        role: UserRole.CLIENT,
      },
      select: {
        id: true,
        name: true,
        username: true,
      },
    });

      if (clients.length === 0) {
      this.logger.debug(`No clients found for agent ${agentId}`);
      return {
        agentId,
        totalIfWin: 0,
        totalIfLose: 0,
        totalFancyPosition: 0,
        totalMatchOddsPosition: 0,
        totalBets: 0,
        totalClients: 0,
        totalMatches: 0,
        matches: [],
      };
    }

    const clientIds = clients.map((c) => c.id);
    this.logger.debug(`Found ${clients.length} clients for agent ${agentId}: [${clientIds.join(', ')}]`);

    // 2️⃣ Fetch ALL pending bets for all clients in ONE query (performance optimization)
    const whereClause: any = {
      userId: { in: clientIds },
      status: BetStatus.PENDING,
    };

    if (eventId) {
      whereClause.eventId = eventId;
      this.logger.debug(`Filtering bets by eventId: ${eventId}`);
    }

    if (marketId) {
      whereClause.marketId = marketId;
      this.logger.debug(`Filtering bets by marketId: ${marketId}`);
    }

    // Filter by market type if provided
    if (marketType) {
      if (marketType === 'match-odds') {
        whereClause.gtype = { in: ['matchodds', 'match'] };
      } else if (marketType === 'fancy') {
        whereClause.gtype = 'fancy';
      }
    }

    const allBets = await this.prisma.bet.findMany({
      where: whereClause,
      select: {
        id: true,
        userId: true,
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
        betName: true,
        status: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    this.logger.debug(`Found ${allBets.length} pending bets across ${clients.length} clients`);

    // 3️⃣ Group bets by eventId first, then by client
    const betsByEventId = new Map<string, typeof allBets[0][]>();
    for (const bet of allBets) {
      const eventIdKey = bet.eventId || 'unknown';
      if (!betsByEventId.has(eventIdKey)) {
        betsByEventId.set(eventIdKey, []);
      }
      betsByEventId.get(eventIdKey)!.push(bet);
    }

    // Get match details for all eventIds
    const eventIds = Array.from(betsByEventId.keys()).filter((id) => id !== 'unknown');
    const matchDetailsMap = new Map<string, any>();

    if (eventIds.length > 0) {
      const matchDetailsResults = await Promise.allSettled(
        eventIds.map(async (eventId) => {
          try {
            const matchDetails = await this.aggregatorService.getMatchDetail(eventId);
            return { eventId, matchDetails: Array.isArray(matchDetails) ? matchDetails : [], success: true };
          } catch (error: any) {
            this.logger.debug(`Could not fetch match details for eventId ${eventId}: ${error?.message || String(error)}`);
            return { eventId, matchDetails: [], success: false };
          }
        }),
      );

      for (let i = 0; i < eventIds.length; i++) {
        const eventId = eventIds[i];
        const result = matchDetailsResults[i];
        if (result.status === 'fulfilled' && result.value.success) {
          const markets = result.value.matchDetails;
          // Try to find match info from markets
          if (markets && markets.length > 0) {
            const firstMarket = markets[0];
            matchDetailsMap.set(eventId, {
              eventName: firstMarket.eventName || firstMarket.event?.name || null,
              homeTeam: firstMarket.homeTeam || firstMarket.event?.homeTeam || null,
              awayTeam: firstMarket.awayTeam || firstMarket.event?.awayTeam || null,
              startTime: firstMarket.startTime || firstMarket.event?.openDate || null,
              markets: markets, // Store full markets array for later use
            });
          }
        }
      }
    }

    // 4️⃣ Get market selections for Match Odds (if needed)
    const marketSelectionsMap = new Map<string, string[]>();

    // Fetch market details for Match Odds markets
    if (eventIds.length > 0 && (!marketType || marketType === 'match-odds')) {
      const matchOddsBets = allBets.filter((bet) => {
        const gtype = (bet.gtype || '').toLowerCase();
        return (gtype === 'matchodds' || gtype === 'match') && bet.marketId;
      });

      if (matchOddsBets.length > 0) {
        // Get unique marketIds
        const marketIds = Array.from(new Set(matchOddsBets.map((b) => b.marketId).filter((id): id is string => !!id)));

        // Extract market selections from already fetched match details
        for (const eventId of eventIds) {
          const matchDetails = matchDetailsMap.get(eventId);
          if (matchDetails && matchDetails.markets) {
            const markets = matchDetails.markets;
            for (const marketId of marketIds) {
              // Find market by marketId
              let matchOddsMarket = markets.find((market: any) => {
                return String(market.marketId) === String(marketId);
              });

              // Fallback to finding by market name
              if (!matchOddsMarket) {
                matchOddsMarket = markets.find((market: any) => {
                  const marketName = (market.marketName || '').toLowerCase();
                  return (
                    marketName === 'match odds' &&
                    !marketName.includes('including tie') &&
                    !marketName.includes('tied match') &&
                    !marketName.includes('completed match')
                  );
                });
              }

              if (matchOddsMarket && matchOddsMarket.runners && Array.isArray(matchOddsMarket.runners)) {
                const selectionIds = matchOddsMarket.runners
                  .map((runner: any) => {
                    const selectionId = runner.selectionId;
                    const runnerName = (runner.runnerName || runner.name || '').toLowerCase();
                    // Skip Yes/No and Tie/Draw runners
                    if (
                      runnerName === 'yes' ||
                      runnerName === 'no' ||
                      runnerName === 'tie' ||
                      runnerName === 'the draw' ||
                      runnerName === 'draw'
                    ) {
                      return null;
                    }
                    return selectionId !== null && selectionId !== undefined ? String(selectionId) : null;
                  })
                  .filter((id): id is string => id !== null);

                if (selectionIds.length > 0) {
                  marketSelectionsMap.set(marketId, selectionIds);
                }
              }
            }
          }
        }
      }
    }

    // 5️⃣ Process each match/eventId separately
    const matchesData: MatchData[] = [];
    let totalAgentIfWin = 0;
    let totalAgentIfLose = 0;
    let totalAgentFancyPosition = 0;
    let totalAgentMatchOddsPosition = 0;

    for (const [eventIdKey, eventBets] of betsByEventId.entries()) {
      if (eventBets.length === 0) continue;

      // Group bets by client for this event
      const betsByClient = new Map<string, typeof eventBets[0][]>();
      const betsForPositionByClient = new Map<string, BetForPosition[]>();
      for (const bet of eventBets) {
        if (!betsByClient.has(bet.userId)) {
          betsByClient.set(bet.userId, []);
          betsForPositionByClient.set(bet.userId, []);
        }
        betsByClient.get(bet.userId)!.push(bet);
        betsForPositionByClient.get(bet.userId)!.push(bet as BetForPosition);
      }

      // Calculate positions per client for this match
      const clientPositions: ClientPosition[] = [];

    for (const client of clients) {
      const clientBets = betsByClient.get(client.id) || [];
      const clientBetsForPosition = betsForPositionByClient.get(client.id) || [];

      // Convert bets to BetDetail format
      const betDetails: BetDetail[] = clientBets.map((bet) => ({
        id: bet.id,
        eventId: bet.eventId,
        marketId: bet.marketId,
        selectionId: bet.selectionId,
        betType: bet.betType,
        betName: bet.betName,
        gtype: bet.gtype,
        amount: bet.amount,
        odds: bet.odds,
        betValue: bet.betValue,
        winAmount: bet.winAmount,
        lossAmount: bet.lossAmount,
        status: bet.status,
        createdAt: bet.createdAt || new Date(),
        username: client.username,
        userName: client.name,
      }));

      if (clientBets.length === 0) {
        clientPositions.push({
          clientId: client.id,
          clientName: client.name,
          clientUsername: client.username,
          matchOddsPosition: null,
          fancyPosition: [],
          totalIfWin: 0,
          totalIfLose: 0,
          bets: [],
        });
        continue;
      }

      // Calculate Match Odds position (use BetForPosition for calculations)
      let matchOddsPosition: MatchOddsPosition | null = null;
      const matchOddsBets = clientBetsForPosition.filter((bet) => {
        const gtype = (bet.gtype || '').toLowerCase();
        return (gtype === 'matchodds' || gtype === 'match') && bet.marketId;
      });

      if (matchOddsBets.length > 0) {
        // Group by marketId
        const matchOddsByMarket = new Map<string, BetForPosition[]>();
        for (const bet of matchOddsBets) {
          if (bet.marketId) {
            if (!matchOddsByMarket.has(bet.marketId)) {
              matchOddsByMarket.set(bet.marketId, []);
            }
            matchOddsByMarket.get(bet.marketId)!.push(bet);
          }
        }

        // Calculate position for first market (or aggregate if multiple)
        // For simplicity, we'll aggregate all Match Odds markets
        const allMatchOddsRunners: Record<string, { net: number }> = {};
        for (const [marketId, marketBets] of matchOddsByMarket.entries()) {
          const marketSelections = marketSelectionsMap.get(marketId);
          if (marketSelections && marketSelections.length > 0) {
            const position = calculateMatchOddsPosition(marketBets, marketId, marketSelections);
            if (position) {
              // Aggregate runners across markets
              for (const [selectionId, runner] of Object.entries(position.runners)) {
                allMatchOddsRunners[selectionId] = {
                  net: (allMatchOddsRunners[selectionId]?.net || 0) + runner.net,
                };
              }
            }
          }
        }

        if (Object.keys(allMatchOddsRunners).length > 0) {
          // Use first marketId as representative (or create a combined one)
          const firstMarketId = Array.from(matchOddsByMarket.keys())[0] || 'combined';
          matchOddsPosition = {
            marketId: firstMarketId,
            runners: allMatchOddsRunners,
          };
        }
      }

      // Calculate Fancy position (use BetForPosition for calculations)
      const fancyPositions = calculateFancyPosition(clientBetsForPosition);

      // Calculate totalIfWin and totalIfLose
      // For Match Odds: sum of all positive net values (if any runner wins)
      // For Fancy: sum of YES positions (if YES wins)
      let totalIfWin = 0;
      let totalIfLose = 0;

      if (matchOddsPosition) {
        // For Match Odds, find the best case (max positive) and worst case (max negative)
        const netValues = Object.values(matchOddsPosition.runners).map((r) => r.net);
        const maxWin = Math.max(...netValues, 0);
        const maxLose = Math.abs(Math.min(...netValues, 0));
        totalIfWin += maxWin;
        totalIfLose += maxLose;
      }

      // For Fancy: Calculate best case (max win) and worst case (max loss)
      // YES position = net P/L if YES wins (can be positive or negative)
      // NO position = net P/L if NO wins (can be positive or negative)
      // We want the best possible outcome (max of YES and NO) and worst possible outcome
      for (const fancyPos of fancyPositions) {
        const yesPos = fancyPos.positions.YES;
        const noPos = fancyPos.positions.NO;
        
        // Best case: maximum of YES and NO positions
        const bestCase = Math.max(yesPos, noPos);
        // Worst case: minimum of YES and NO positions (most negative)
        const worstCase = Math.min(yesPos, noPos);
        
        // Add to totals (best case = ifWin, worst case = ifLose)
        if (bestCase > 0) {
          totalIfWin += bestCase;
        }
        if (worstCase < 0) {
          totalIfLose += Math.abs(worstCase);
        }
      }

      clientPositions.push({
        clientId: client.id,
        clientName: client.name,
        clientUsername: client.username,
        matchOddsPosition,
        fancyPosition: fancyPositions,
        totalIfWin,
        totalIfLose,
        bets: betDetails,
      });
    }

      // Aggregate for Agent for this match (inverse of client positions)
      let matchAgentIfWin = 0;
      let matchAgentIfLose = 0;
      let matchAgentFancyPosition = 0;
      let matchAgentMatchOddsPosition = 0;

      // Aggregate Match Odds positions (inverse)
      const agentMatchOddsRunners: Record<string, { net: number }> = {};
      for (const clientPos of clientPositions) {
        if (clientPos.matchOddsPosition) {
          for (const [selectionId, runner] of Object.entries(clientPos.matchOddsPosition.runners)) {
            // Agent position is inverse of client position
            agentMatchOddsRunners[selectionId] = {
              net: (agentMatchOddsRunners[selectionId]?.net || 0) - runner.net,
            };
          }
        }
      }

      if (Object.keys(agentMatchOddsRunners).length > 0) {
        const netValues = Object.values(agentMatchOddsRunners).map((r) => r.net);
        matchAgentMatchOddsPosition = netValues.reduce((sum, net) => sum + Math.abs(net), 0) / 2; // Average exposure
      }

      // Aggregate Fancy positions (inverse)
      const agentFancyPositions = new Map<string, { YES: number; NO: number }>();
      for (const clientPos of clientPositions) {
        for (const fancyPos of clientPos.fancyPosition) {
          const existing = agentFancyPositions.get(fancyPos.fancyId) || { YES: 0, NO: 0 };
          // Agent position is inverse of client position
          agentFancyPositions.set(fancyPos.fancyId, {
            YES: existing.YES - fancyPos.positions.YES,
            NO: existing.NO - fancyPos.positions.NO,
          });
        }
      }

      for (const fancyPos of agentFancyPositions.values()) {
        matchAgentFancyPosition += Math.max(Math.abs(fancyPos.YES), Math.abs(fancyPos.NO));
      }

      // Agent totals are inverse of client totals for this match
      for (const clientPos of clientPositions) {
        matchAgentIfWin -= clientPos.totalIfWin;
        matchAgentIfLose -= clientPos.totalIfLose;
      }

      // Get match details
      const matchDetails = eventIdKey !== 'unknown' ? matchDetailsMap.get(eventIdKey) : null;
      const totalAmount = eventBets.reduce((sum, bet) => sum + (bet.betValue || bet.amount || 0), 0);

      matchesData.push({
        eventId: eventIdKey,
        matchTitle: matchDetails?.eventName || `${matchDetails?.homeTeam || ''} v ${matchDetails?.awayTeam || ''}`.trim() || null,
        homeTeam: matchDetails?.homeTeam || null,
        awayTeam: matchDetails?.awayTeam || null,
        startTime: matchDetails?.startTime ? new Date(matchDetails.startTime) : null,
        totalBets: eventBets.length,
        totalAmount,
        agentTotalIfWin: matchAgentIfWin,
        agentTotalIfLose: matchAgentIfLose,
        agentTotalFancyPosition: matchAgentFancyPosition,
        agentTotalMatchOddsPosition: matchAgentMatchOddsPosition,
        clients: clientPositions,
      });

      // Accumulate totals
      totalAgentIfWin += matchAgentIfWin;
      totalAgentIfLose += matchAgentIfLose;
      totalAgentFancyPosition += matchAgentFancyPosition;
      totalAgentMatchOddsPosition += matchAgentMatchOddsPosition;
    }

    return {
      agentId,
      totalIfWin: totalAgentIfWin,
      totalIfLose: totalAgentIfLose,
      totalFancyPosition: totalAgentFancyPosition,
      totalMatchOddsPosition: totalAgentMatchOddsPosition,
      totalBets: allBets.length,
      totalClients: clients.length,
      totalMatches: matchesData.length,
      matches: matchesData,
    };
  }
}

