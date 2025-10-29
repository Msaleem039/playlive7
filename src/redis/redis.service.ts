import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  /**
   * Get data from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.cacheManager.get<T>(key);
      if (data) {
        this.logger.debug(`✅ Cache HIT for key: ${key}`);
      } else {
        this.logger.debug(`❌ Cache MISS for key: ${key}`);
      }
      return data || null;
    } catch (error) {
      this.logger.error(`Error getting cache for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set data in cache with TTL
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      await this.cacheManager.set(key, value, ttl);
      this.logger.debug(`💾 Cached data for key: ${key} (TTL: ${ttl || 'default'}s)`);
    } catch (error) {
      this.logger.error(`Error setting cache for key ${key}:`, error);
    }
  }

  /**
   * Delete data from cache
   */
  async del(key: string): Promise<void> {
    try {
      await this.cacheManager.del(key);
      this.logger.debug(`🗑️ Deleted cache for key: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting cache for key ${key}:`, error);
    }
  }

  /**
   * Clear all cache
   */
  async reset(): Promise<void> {
    try {
      // Note: cache-manager doesn't have a reset method, we'll implement a workaround
      this.logger.log('🧹 Cache reset requested (not implemented in cache-manager)');
    } catch (error) {
      this.logger.error('Error clearing cache:', error);
    }
  }

  /**
   * Get or set pattern - if cache miss, execute function and cache result
   */
  async getOrSet<T>(
    key: string,
    fetchFunction: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    try {
      // Try to get from cache first
      let data = await this.get<T>(key);
      
      if (data === null) {
        // Cache miss - fetch data and cache it
        this.logger.debug(`🔄 Cache MISS - fetching data for key: ${key}`);
        data = await fetchFunction();
        await this.set(key, data, ttl);
      }
      
      return data;
    } catch (error) {
      this.logger.error(`Error in getOrSet for key ${key}:`, error);
      // Fallback to direct fetch if cache fails
      return await fetchFunction();
    }
  }

  /**
   * Cache cricket matches with specific TTL
   */
  async cacheCricketMatches(matches: any[], ttl: number = 60): Promise<void> {
    const key = 'cricket:matches:live';
    await this.set(key, matches, ttl);
  }

  /**
   * Get cached cricket matches
   */
  async getCachedCricketMatches(): Promise<any[] | null> {
    const key = 'cricket:matches:live';
    return await this.get<any[]>(key);
  }

  /**
   * Cache specific match data
   */
  async cacheMatch(matchId: number, matchData: any, ttl: number = 300): Promise<void> {
    const key = `cricket:match:${matchId}`;
    await this.set(key, matchData, ttl);
  }

  /**
   * Get cached match data
   */
  async getCachedMatch(matchId: number): Promise<any | null> {
    const key = `cricket:match:${matchId}`;
    return await this.get<any>(key);
  }

  /**
   * Cache competitions data
   */
  async cacheCompetitions(competitions: any[], ttl: number = 1800): Promise<void> {
    const key = 'cricket:competitions';
    await this.set(key, competitions, ttl);
  }

  /**
   * Get cached competitions
   */
  async getCachedCompetitions(): Promise<any[] | null> {
    const key = 'cricket:competitions';
    return await this.get<any[]>(key);
  }

  /**
   * Cache teams data
   */
  async cacheTeams(teams: any[], ttl: number = 3600): Promise<void> {
    const key = 'cricket:teams';
    await this.set(key, teams, ttl);
  }

  /**
   * Get cached teams
   */
  async getCachedTeams(): Promise<any[] | null> {
    const key = 'cricket:teams';
    return await this.get<any[]>(key);
  }

  /**
   * Invalidate match-specific cache
   */
  async invalidateMatchCache(matchId: number): Promise<void> {
    const keys = [
      `cricket:match:${matchId}`,
      'cricket:matches:live', // Also invalidate live matches list
    ];
    
    for (const key of keys) {
      await this.del(key);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{ hits: number; misses: number; keys: string[] }> {
    // This is a simplified version - in production you'd want more detailed stats
    return {
      hits: 0,
      misses: 0,
      keys: []
    };
  }
}
