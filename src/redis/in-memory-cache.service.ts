import { Injectable, Logger } from '@nestjs/common';

interface CacheItem<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

@Injectable()
export class InMemoryCacheService {
  private readonly logger = new Logger(InMemoryCacheService.name);
  private cache = new Map<string, CacheItem<any>>();
  private readonly maxSize = 1000; // Maximum number of items in cache

  /**
   * Get data from cache
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const item = this.cache.get(key);
      
      if (!item) {
        this.logger.debug(`❌ Cache MISS for key: ${key}`);
        return null;
      }

      // Check if item has expired
      const now = Date.now();
      if (now - item.timestamp > item.ttl * 1000) {
        this.cache.delete(key);
        this.logger.debug(`⏰ Cache EXPIRED for key: ${key}`);
        return null;
      }

      this.logger.debug(`✅ Cache HIT for key: ${key}`);
      return item.data;
    } catch (error) {
      this.logger.error(`Error getting cache for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set data in cache with TTL
   */
  async set<T>(key: string, value: T, ttl: number = 300): Promise<void> {
    try {
      // Implement LRU eviction if cache is full
      if (this.cache.size >= this.maxSize) {
        this.evictLRU();
      }

      this.cache.set(key, {
        data: value,
        timestamp: Date.now(),
        ttl: ttl
      });

      this.logger.debug(`💾 Cached data for key: ${key} (TTL: ${ttl}s)`);
    } catch (error) {
      this.logger.error(`Error setting cache for key ${key}:`, error);
    }
  }

  /**
   * Delete data from cache
   */
  async del(key: string): Promise<void> {
    try {
      this.cache.delete(key);
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
      this.cache.clear();
      this.logger.log('🧹 Cleared all cache');
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
   * Evict Least Recently Used item
   */
  private evictLRU(): void {
    let oldestKey = '';
    let oldestTime = Date.now();

    for (const [key, item] of this.cache.entries()) {
      if (item.timestamp < oldestTime) {
        oldestTime = item.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.logger.debug(`🗑️ Evicted LRU item: ${oldestKey}`);
    }
  }

  /**
   * Clean expired items
   */
  async cleanExpired(): Promise<void> {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.ttl * 1000) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`🧹 Cleaned ${cleanedCount} expired items`);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{ 
    size: number; 
    maxSize: number; 
    hitRate: number; 
    keys: string[] 
  }> {
    const keys = Array.from(this.cache.keys());
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0, // Would need to track hits/misses for accurate rate
      keys: keys.slice(0, 10) // Show first 10 keys
    };
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
}
