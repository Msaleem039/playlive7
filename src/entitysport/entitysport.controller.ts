import { Controller, Get, Param, Query } from '@nestjs/common';
import { EntitySportService } from './entitysport.service';

@Controller('entitysport')
export class EntitySportController {
  constructor(private readonly entitySportService: EntitySportService) {}

  @Get('seasons')
  getSeasons(@Query('sid') sid?: number) {
    return this.entitySportService.getSeasons(sid);
  }

  @Get('competitions')
  getCompetitions(@Query('cid') cid?: number) {
    return this.entitySportService.getCompetitionsWithArgs(cid);
  }

  @Get('matches')
  getMatches(
    @Query('mid') mid?: number,
    @Query('page') page?: number,
    @Query('per_page') per_page?: number,
  ) {
    // If a specific match id is requested, keep existing behavior
    if (mid) {
      const args: Record<string, any> = {};
      if (page) args.page = page;
      if (per_page) args.per_page = per_page;
      return this.entitySportService.getMatchesWithArgs(mid, args);
    }

    // Otherwise, return combined live + upcoming matches
    return this.entitySportService.getCombinedMatches();
  }

  @Get('matches/live-ids')
  getLiveMatchIds() {
    return this.entitySportService.getCurrentLiveMatchIds();
  }

  @Get('matches/:mid/live')
  getLiveMatch(@Param('mid') mid: number) {
    return this.entitySportService.getLiveMatch(mid);
  }

  @Get('matches/:mid/scorecard')
  getScorecard(@Param('mid') mid: number) {
    return this.entitySportService.getScorecard(mid);
  }

  @Get('matches/:mid/commentary/:inning')
  getCommentary(@Param('mid') mid: number, @Param('inning') inning: number) {
    return this.entitySportService.getCommentary(mid, inning);
  }

  // Cricket Exchange Endpoints

  @Get('cricket/exchange/matches')
  async getExchangeMatches(@Query() query: Record<string, any>) {
    try {
      console.log('Received query:', query);
      
      // Handle malformed URLs like ?status=live?page=1&per_page=10
      const cleanQuery: Record<string, any> = {};
      
      Object.keys(query).forEach(key => {
        let value = query[key];
        
        // If value contains ?, it's malformed - split and extract proper values
        if (typeof value === 'string' && value.includes('?')) {
          const parts = value.split('?');
          cleanQuery[key] = parts[0]; // Take the first part
          
          // Parse additional parameters from the malformed part
          if (parts[1]) {
            const additionalParams = parts[1].split('&');
            additionalParams.forEach(param => {
              const [paramKey, paramValue] = param.split('=');
              if (paramKey && paramValue) {
                cleanQuery[paramKey] = paramValue;
              }
            });
          }
        } else {
          cleanQuery[key] = value;
        }
      });
      
      console.log('Cleaned query:', cleanQuery);
      const result = await this.entitySportService.getExchangeMatches(cleanQuery);
      return result;
    } catch (error) {
      console.error('Error in getExchangeMatches:', error);
      return {
        status: 'error',
        message: 'Internal server error',
        error: error.message
      };
    }
  }

  // New endpoint for WebSocket connection info
  @Get('cricket/exchange/websocket-info')
  getWebSocketInfo() {
    return {
      websocketUrl: 'ws://localhost:3000/entitysport',
      events: {
        subscribe: 'Subscribe to live updates',
        realtimeUpdate: 'Real-time data from EntitySport WebSocket',
        liveUpdate: 'General live updates from HTTP polling'
      },
      example: {
        connect: 'io("ws://localhost:3000/entitysport")',
        subscribe: 'socket.emit("subscribe", { event: "entitySportRealtimeData" })'
      }
    };
  }

  @Get('cricket/exchange/series')
  getExchangeSeries(@Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeSeries(query);
  }

  @Get('cricket/exchange/teams')
  getExchangeTeams(@Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeTeams(query);
  }

  @Get('cricket/exchange/matches/:mid/info')
  getExchangeMatchInfo(@Param('mid') mid: number, @Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeMatchInfo(mid, query);
  }

  @Get('cricket/exchange/matches/:mid/live')
  getExchangeLiveScore(@Param('mid') mid: number, @Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeLiveScore(mid, query);
  }

  @Get('cricket/exchange/matches/:mid/scorecard')
  getExchangeScorecard(@Param('mid') mid: number, @Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeScorecard(mid, query);
  }

  @Get('cricket/exchange/matches/:mid/commentary/:inning')
  getExchangeCommentary(
    @Param('mid') mid: number, 
    @Param('inning') inning: number,
    @Query() query: Record<string, any>
  ) {
    return this.entitySportService.getExchangeCommentary(mid, inning, query);
  }

  @Get('cricket/exchange/matches/:mid/markets')
  getExchangeMarkets(@Param('mid') mid: number, @Query() query: Record<string, any>) {
    return this.entitySportService.getExchangeMarkets(mid, query);
  }

  @Get('cricket/exchange/matches/:mid/odds')
  getExchangeOdds(
    @Param('mid') mid: number, 
    @Query() query: Record<string, any>,
    @Query('market_id') marketId?: string
  ) {
    return this.entitySportService.getExchangeOdds(mid, marketId, query);
  }

  @Get('cricket/exchange/matches/:mid/markets/:marketId/odds')
  getExchangeMarketOdds(
    @Param('mid') mid: number,
    @Param('marketId') marketId: string,
    @Query() query: Record<string, any>
  ) {
    return this.entitySportService.getExchangeOdds(mid, marketId, query);
  }

  // ✅ New endpoint for match odds and details
  @Get('cricket/exchange/matches/:matchId/odds-details')
  getMatchOddsDetails(@Param('matchId') matchId: number) {
    console.log("🎯 DEBUG: Controller received request for match odds:", matchId);
    return this.entitySportService.getMatchOdds(matchId);
  }

  // ✅ Debug endpoint to check WebSocket connection status
  @Get('debug/websocket-status')
  getWebSocketDebugStatus() {
    return {
      message: 'WebSocket debug status',
      timestamp: new Date().toISOString(),
      instructions: {
        checkConsole: 'Check server console for DEBUG messages',
        websocketEvents: 'Look for messages starting with 🔌, ✅, 📡, ❌, ⚠️',
        liveDataEvents: 'Look for messages starting with 🔄, 📦, 📊',
        oddsEvents: 'Look for messages starting with 🎯'
      },
      expectedDebugMessages: [
        '🔌 DEBUG: Connecting to EntitySport WebSocket',
        '✅ DEBUG: WebSocket connection established successfully',
        '📡 DEBUG: Sending subscription message',
        '📡 DEBUG: Raw WebSocket data received',
        '🔄 DEBUG: Starting live competitions fetch',
        '🎯 DEBUG: Getting match odds for match ID'
      ]
    };
  }

  // Polling Status Endpoints

  @Get('polling/status')
  getPollingStatus() {
    return { 
      status: 'HTTP Polling Active', 
      interval: '15 seconds',
      endpoint: 'https://trial-api.sportbex.com/api/sportbex/competitions/4',
      timestamp: new Date().toISOString() 
    };
  }

  // WebSocket Status
  @Get('websocket/status')
  getWebSocketStatus() {
    return {
      status: 'WebSocket Gateway Active',
      namespace: '/entitysport',
      endpoint: 'ws://localhost:3000/entitysport',
      events: ['cricketExchange', 'sportbexLiveData'],
      timestamp: new Date().toISOString()
    };
  }
}
