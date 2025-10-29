import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { EntitySportGateway } from './entitysport.gateway';
import { RedisService } from '../redis/redis.service';
import WebSocket from 'ws';

// Interface for WebSocket errors that may have additional properties
interface WebSocketError extends Error {
  code?: string | number;
  type?: string;
}

@Injectable()
export class EntitySportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EntitySportService.name);
  
  // ✅ EntitySport base URL and API token
  private readonly BASE_URL = 'https://restapi.entitysport.com/exchange';
  private readonly API_TOKEN = 'd38dee8f66ed335ade8562f873db7468';

  private pollingSubscription: Subscription | null = null;
  private entitySportWebSocket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectInterval = 5000; // 5 seconds
  private currentLiveMatchIds: number[] = []; // Store current live match IDs

  constructor(
    private readonly httpService: HttpService,
    private readonly entitySportGateway: EntitySportGateway,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    this.logger.log('Starting EntitySport live polling...');
    this.startPolling();
    this.logger.log('Connecting to EntitySport WebSocket...');
    this.connectToEntitySportWebSocket();
  }

  onModuleDestroy() {
    this.logger.log('Stopping EntitySport polling...');
    this.stopPolling();
    this.logger.log('Disconnecting from EntitySport WebSocket...');
    this.disconnectFromEntitySportWebSocket();
  }

  private startPolling() {
    // Poll every 15 seconds for live updates
    this.pollingSubscription = interval(15000).subscribe(() => {
      this.fetchLiveCompetitions();
    });
    this.fetchLiveCompetitions(); // fetch immediately on startup
  }

  private stopPolling() {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  // ✅ EntitySport WebSocket connection methods
  private connectToEntitySportWebSocket() {
    try {
      const wsUrl = `ws://webhook.entitysport.com:8087/connect?token=${this.API_TOKEN}`;
      this.logger.log(`🔌 Connecting to EntitySport WebSocket: ${wsUrl}`);
      // console.log("🔌 DEBUG: Connecting to EntitySport WebSocket: ", wsUrl);
      // console.log("🔌 DEBUG: API Token being used: ", this.API_TOKEN);
      
      this.entitySportWebSocket = new WebSocket(wsUrl);
      
      this.entitySportWebSocket.on('open', () => {
        this.logger.log('✅ Connected to EntitySport WebSocket');
        console.log("✅ DEBUG: WebSocket connection established successfully");
        this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
      
        // ✅ SUBSCRIBE TO LIVE MATCHES DYNAMICALLY
        this.subscribeToLiveMatches();
      });

      this.entitySportWebSocket.on('message', (data: WebSocket.Data) => {
        try {
          const rawData = data.toString();
          // console.log("📡 DEBUG: Raw WebSocket data received:", rawData);
          // console.log("📡 DEBUG: Data length:", rawData.length);
          
          const message = JSON.parse(rawData);
          // console.log("📡 DEBUG: Parsed WebSocket message:", JSON.stringify(message, null, 2));
          
          this.logger.log('📡 Received real-time data from EntitySport WebSocket');
          // console.log("📡 DEBUG: Message type:", message.type || 'unknown');
          // console.log("📡 DEBUG: Message keys:", Object.keys(message));
          
          // Check if this is live match data
          // if (message.match_id) {
          //   console.log("📡 DEBUG: Live match data detected for match ID:", message.match_id);
          // }
          
          // if (message.odds) {
          //   console.log("📡 DEBUG: Odds data detected:", message.odds);
          // }
          
          // if (message.score) {
          //   console.log("📡 DEBUG: Score data detected:", message.score);
          // }
          
          // Broadcast the real-time data to connected clients
          this.entitySportGateway.broadcastLiveUpdate('entitySportRealtimeData', {
            timestamp: new Date().toISOString(),
            data: message,
            source: 'websocket'
          });
          
          console.log("📡 DEBUG: Data broadcasted to WebSocket clients");
        } catch (error) {
          this.logger.error('Error parsing EntitySport WebSocket message:', error);
          console.log("❌ DEBUG: Error parsing WebSocket message:", error);
          console.log("❌ DEBUG: Raw data that failed to parse:", data.toString());
        }
      });

      // this.entitySportWebSocket.on('error', (error: WebSocketError) => {
      //   this.logger.error('EntitySport WebSocket error:', error);
      //   console.log("❌ DEBUG: WebSocket error occurred:", error);
      //   console.log("❌ DEBUG: Error details:", {
      //     message: error.message,
      //     code: error.code,
      //     type: error.type
      //   });
      //   this.handleWebSocketReconnect();
      // });

      // this.entitySportWebSocket.on('close', (code, reason) => {
      //   this.logger.warn(`EntitySport WebSocket closed. Code: ${code}, Reason: ${reason}`);
      //   console.log("⚠️ DEBUG: WebSocket connection closed");
      //   console.log("⚠️ DEBUG: Close code:", code);
      //   console.log("⚠️ DEBUG: Close reason:", reason);
      //   this.handleWebSocketReconnect();
      // });

    } catch (error) {
      this.logger.error('Failed to connect to EntitySport WebSocket:', error);
      console.log("❌ DEBUG: Failed to create WebSocket connection:", error);
      this.handleWebSocketReconnect();
    }
  }

  private handleWebSocketReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.logger.log(`Attempting to reconnect to EntitySport WebSocket (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      
      setTimeout(() => {
        this.connectToEntitySportWebSocket();
      }, this.reconnectInterval);
    } else {
      this.logger.error('Max reconnection attempts reached. EntitySport WebSocket connection failed.');
    }
  }

  private disconnectFromEntitySportWebSocket() {
    if (this.entitySportWebSocket) {
      this.entitySportWebSocket.close();
      this.entitySportWebSocket = null;
      this.logger.log('Disconnected from EntitySport WebSocket');
    }
  }

  // ✅ Subscribe to live matches via WebSocket
  private async subscribeToLiveMatches() {
    try {
      // Get current live match IDs
      const liveMatchIds = await this.getLiveMatchIds();
      
      if (liveMatchIds.length === 0) {
        this.logger.warn('No live matches found to subscribe to');
        console.log("⚠️ DEBUG: No live matches found to subscribe to");
        return;
      }
      
      // Subscribe to each live match
      for (const matchId of liveMatchIds) {
        const subscribeMessage = JSON.stringify({
          type: "subscribe",
          match_id: matchId
        });
        
        console.log("📡 DEBUG: Sending subscription message:", subscribeMessage);
        this.entitySportWebSocket?.send(subscribeMessage);
        this.logger.log(`📡 Subscribed to live match: ${matchId}`);
        console.log("📡 DEBUG: Subscription message sent for match ID:", matchId);
      }
      
      this.logger.log(`📡 Successfully subscribed to ${liveMatchIds.length} live matches`);
    } catch (error) {
      this.logger.error(`Error subscribing to live matches: ${error.message}`);
      console.log("❌ DEBUG: Error subscribing to live matches:", error.message);
    }
  }

  // ✅ Get current live match IDs from API
  private async getLiveMatchIds(): Promise<number[]> {
    try {
      const url = `${this.BASE_URL}/matches/`;
      const params = { 
        status: '1', // Live matches
        token: this.API_TOKEN 
      };
      
      console.log("🎯 DEBUG: Fetching live match IDs...");
      const { data } = await firstValueFrom(this.httpService.get(url, { params }));
      
      if (data.response && data.response.items) {
        const liveMatchIds = data.response.items.map((match: any) => match.match_id);
        console.log("🎯 DEBUG: Found live match IDs:", liveMatchIds);
        this.logger.log(`Found ${liveMatchIds.length} live matches: ${liveMatchIds.join(', ')}`);
        return liveMatchIds;
      }
      
      console.log("🎯 DEBUG: No live matches found");
      return [];
    } catch (error) {
      this.logger.error(`Error fetching live match IDs: ${error.message}`);
      console.log("❌ DEBUG: Error fetching live match IDs:", error.message);
      return [];
    }
  }

  // ✅ Fetch live matches from EntitySport with Redis caching
  private async fetchLiveCompetitions() {
    try {
      const cacheKey = 'cricket:matches:live';
      const cacheTTL = 30; // Cache for 30 seconds for live data
      
      console.log("🔄 DEBUG: Starting live competitions fetch...");
      
      // Try to get from cache first
      let cachedData = await this.redisService.get(cacheKey);
      
      if (cachedData) {
        this.logger.log(`📦 Using cached live matches data`);
        console.log("📦 DEBUG: Using cached data for live matches");
        console.log("📦 DEBUG: Cached data keys:", Object.keys(cachedData));
        
        // Broadcast cached data
        this.entitySportGateway.broadcastLiveUpdate('entitySportLiveData', {
          timestamp: new Date().toISOString(),
          data: cachedData,
          cached: true,
        });
        return;
      }

      // Cache miss - fetch from API
      this.logger.log(`🔄 Cache miss - fetching live matches from EntitySport API`);
      console.log("🔄 DEBUG: Cache miss - fetching from EntitySport API");
      
      const url = `${this.BASE_URL}/matches/`;
      const params = { 
        status: '1', // Live matches
        token: this.API_TOKEN 
      };
      
      console.log("🔄 DEBUG: API URL:", url);
      console.log("🔄 DEBUG: API Params:", params);
      
      const { data } = await firstValueFrom(this.httpService.get(url, { params }));

      console.log("✅ DEBUG: API response received");
      console.log("✅ DEBUG: Response status:", data.status);
      console.log("✅ DEBUG: Response keys:", Object.keys(data));

      // Cache the data
      await this.redisService.set(cacheKey, data, cacheTTL);

      // Log more details about the data
      this.logger.log(`✅ EntitySport live matches fetched and cached successfully`);
      console.log("✅ DEBUG: Data cached successfully");
      
      if (data.response && data.response.items) {
        this.logger.log(`Found ${data.response.items.length} live matches`);
        console.log("📊 DEBUG: Found", data.response.items.length, "live matches");
        
        // Store current live match IDs
        this.currentLiveMatchIds = data.response.items.map((match: any) => match.match_id);
        console.log("📊 DEBUG: Current live match IDs:", this.currentLiveMatchIds);
        
        if (data.response.items.length > 0) {
          this.logger.log(`First live match: ${data.response.items[0].title} - Status: ${data.response.items[0].status_str}`);
          console.log("📊 DEBUG: First live match details:", {
            id: data.response.items[0].match_id,
            title: data.response.items[0].title,
            status: data.response.items[0].status_str,
            status_note: data.response.items[0].status_note
          });
        }
      } else {
        console.log("⚠️ DEBUG: No live matches found in response");
        console.log("⚠️ DEBUG: Response structure:", JSON.stringify(data, null, 2));
      }

      // Broadcast via Socket Gateway
      this.entitySportGateway.broadcastLiveUpdate('entitySportLiveData', {
        timestamp: new Date().toISOString(),
        data,
        cached: false,
      });
      
      console.log("📡 DEBUG: Live data broadcasted to WebSocket clients");
    } catch (error) {
      this.logger.error(`Error fetching EntitySport data: ${error.message}`);
      console.log("❌ DEBUG: Error fetching EntitySport data:", error.message);
      console.log("❌ DEBUG: Error details:", {
        status: error.response?.status,
        statusText: error.response?.statusText,
        url: error.config?.url,
        params: error.config?.params
      });
      
      // Try to serve stale cache data if API fails
      try {
        const staleData = await this.redisService.get('cricket:matches:live');
        if (staleData) {
          this.logger.log(`📦 Serving stale cache data due to API error`);
          console.log("📦 DEBUG: Serving stale cache data due to API error");
          this.entitySportGateway.broadcastLiveUpdate('entitySportLiveData', {
            timestamp: new Date().toISOString(),
            data: staleData,
            cached: true,
            stale: true,
          });
        } else {
          console.log("❌ DEBUG: No stale cache data available");
        }
      } catch (cacheError) {
        this.logger.error(`Error accessing cache during API failure: ${cacheError.message}`);
        console.log("❌ DEBUG: Cache access error:", cacheError.message);
      }
    }
  }

  // ✅ General reusable GET request method for EntitySport API with Redis caching
  private async makeRequest(endpoint: string, params: Record<string, any> = {}, cacheTTL: number = 300) {
    try {
      // Create cache key based on endpoint and params
      const cacheKey = `cricket:${endpoint}:${JSON.stringify(params)}`;
      
      // Try to get from cache first
      const cachedData = await this.redisService.get(cacheKey);
      if (cachedData) {
        this.logger.debug(`📦 Cache HIT for ${endpoint}`);
        return cachedData;
      }

      // Cache miss - fetch from API
      this.logger.debug(`🔄 Cache MISS for ${endpoint} - fetching from API`);
      const url = `${this.BASE_URL}/${endpoint}`;
      const requestParams = { 
        ...params, 
        token: this.API_TOKEN 
      };
      
      this.logger.log(`Making EntitySport request to: ${url}`);
      this.logger.log(`Request params: ${JSON.stringify(requestParams)}`);
      
      const response = await firstValueFrom(this.httpService.get(url, { params: requestParams }));
      
      // Cache the response
      await this.redisService.set(cacheKey, response.data, cacheTTL);
      
      this.logger.log(`✅ EntitySport response received and cached successfully`);
      return response.data;
    } catch (error) {
      this.logger.error(`EntitySport API Error for endpoint ${endpoint}:`, error);
      this.logger.error(`Full error details:`, {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        params: error.config?.params
      });
      
      // Try to return stale cache data if API fails
      try {
        const cacheKey = `cricket:${endpoint}:${JSON.stringify(params)}`;
        const staleData = await this.redisService.get(cacheKey);
        if (staleData) {
          this.logger.log(`📦 Serving stale cache data due to API error for ${endpoint}`);
          return staleData;
        }
      } catch (cacheError) {
        this.logger.error(`Error accessing cache during API failure: ${cacheError.message}`);
      }
      
      // Return a mock response instead of throwing error
      return {
        status: 'error',
        message: `EntitySport API Error: ${error.message}`,
        data: [],
        details: {
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config?.url,
          params: error.config?.params
        }
      };
    }
  }

  // ✅ Example endpoints similar to EntitySport methods
  async getCompetitions(id?: number) {
    const endpoint = id ? `competitions/${id}` : 'competitions';
    return this.makeRequest(endpoint);
  }

  async getMatches() {
    return this.makeRequest('matches');
  }

  async getMatchById(id: number) {
    return this.makeRequest(`matches/${id}`);
  }

  async getTeams() {
    return this.makeRequest('teams');
  }

  async getPlayers() {
    return this.makeRequest('players');
  }

  // Additional methods to match controller expectations
  async getSeasons(sid?: number, args?: Record<string, any>) {
    return this.makeRequest('seasons');
  }

  async getCompetitionsWithArgs(cid?: number, args?: Record<string, any>) {
    return this.getCompetitions(cid);
  }

  async getMatchesWithArgs(mid?: number, args?: Record<string, any>) {
    return mid ? this.getMatchById(mid) : this.getMatches();
  }

  async getLiveMatch(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getScorecard(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getCommentary(mid: number, inning: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeMatches(args?: Record<string, any>) {
    const params = {
      status: args?.status || '2', // Default to completed matches
      ...args
    };
    return this.makeRequest('matches', params);
  }
  

  async getExchangeSeries(args?: Record<string, any>) {
    return this.makeRequest('competitions');
  }

  async getExchangeTeams(args?: Record<string, any>) {
    return this.makeRequest('teams');
  }

  async getExchangeMatchInfo(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeLiveScore(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeScorecard(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeCommentary(mid: number, inning: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeMarkets(mid: number, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  async getExchangeOdds(mid: number, marketId?: string, args?: Record<string, any>) {
    return this.getMatchById(mid);
  }

  // ✅ Public method to get current live match IDs
  async getCurrentLiveMatchIds(): Promise<number[]> {
    return this.getLiveMatchIds();
  }

  // ✅ New method for getting match odds and details
  async getMatchOdds(matchId: number) {
    console.log("🎯 DEBUG: Getting match odds for match ID:", matchId);
    
    const endpoint = 'matchesmultiodds';
    const params = { match_id: matchId };
    const cacheTTL = 10; // Cache for 10 seconds for odds data (frequent updates)
    
    console.log("🎯 DEBUG: Endpoint:", endpoint);
    console.log("🎯 DEBUG: Params:", params);
    console.log("🎯 DEBUG: Cache TTL:", cacheTTL);
    
    const result = await this.makeRequest(endpoint, params, cacheTTL);
    
    console.log("🎯 DEBUG: Match odds result received");
    console.log("🎯 DEBUG: Result status:", result.status);
    console.log("🎯 DEBUG: Result keys:", Object.keys(result));
    
    if (result.response && result.response.items) {
      console.log("🎯 DEBUG: Found", result.response.items.length, "odds items");
      if (result.response.items.length > 0) {
        console.log("🎯 DEBUG: First odds item:", JSON.stringify(result.response.items[0], null, 2));
      }
    }
    
    return result;
  }
}
