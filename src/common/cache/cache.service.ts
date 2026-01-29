import { Injectable, Logger } from '@nestjs/common';

/**
 * ✅ PERFORMANCE OPTIMIZATION: In-Memory Cache Service
 * 
 * Provides fast, deterministic caching for:
 * - Vendor API responses (odds, fancy, match data)
 * - Position calculations
 * - Exposure calculations
 * - PnL data
 * 
 * Cache keys are deterministic based on input parameters.
 * TTL is configurable per cache type.
 * 
 * ⚠️ CRITICAL: This does NOT change business logic - only caches results.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cache = new Map<string, { data: any; expiresAt: number }>();
  
  // Cache TTLs (in milliseconds)
  private readonly TTL = {
    VENDOR_API: 5000,      // 3 seconds (vendor data changes frequently)
    POSITION: 3000,        // 2 seconds (positions change on bet placement)
    EXPOSURE: 3000,        // 2 seconds (exposure changes on bet placement)
    PNL: 5000,             // 5 seconds (PnL changes less frequently)
    MATCH_DATA: 10000,     // 10 seconds (match data changes slowly)
  };

  /**
   * Get cached data if available and not expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }
    
    if (Date.now() > entry.expiresAt) {
      // Expired - remove and return null
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  /**
   * Set cache with TTL
   */
  set(key: string, data: any, ttl?: number): void {
    const ttlMs = ttl || this.TTL.VENDOR_API;
    const expiresAt = Date.now() + ttlMs;
    
    this.cache.set(key, { data, expiresAt });
  }

  /**
   * Delete cache entry
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Generate deterministic cache key for vendor API calls
   */
  getVendorApiKey(type: 'odds' | 'fancy' | 'bookmaker-fancy' | 'match-detail', eventId: string, marketIds?: string): string {
    if (marketIds) {
      return `vendor:${type}:${eventId}:${marketIds}`;
    }
    return `vendor:${type}:${eventId}`;
  }

  /**
   * Generate deterministic cache key for position calculations
   */
  getPositionKey(userId: string, marketId: string, eventId?: string): string {
    if (eventId) {
      return `position:${userId}:${marketId}:${eventId}`;
    }
    return `position:${userId}:${marketId}`;
  }

  /**
   * Generate deterministic cache key for exposure calculations
   */
  getExposureKey(userId: string, marketId: string): string {
    return `exposure:${userId}:${marketId}`;
  }

  /**
   * Generate deterministic cache key for PnL data
   */
  getPnlKey(userId: string, eventId: string, marketType?: string): string {
    if (marketType) {
      return `pnl:${userId}:${eventId}:${marketType}`;
    }
    return `pnl:${userId}:${eventId}`;
  }

  /**
   * Invalidate cache entries matching a pattern
   * Used when bets are placed or settled
   */
  invalidatePattern(pattern: string): void {
    const regex = new RegExp(pattern);
    const keysToDelete: string[] = [];
    
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
    
    if (keysToDelete.length > 0) {
      this.logger.debug(`Invalidated ${keysToDelete.length} cache entries matching pattern: ${pattern}`);
    }
  }

  /**
   * Clean expired entries (should be called periodically)
   */
  cleanExpired(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
    
    if (keysToDelete.length > 0) {
      this.logger.debug(`Cleaned ${keysToDelete.length} expired cache entries`);
    }
  }

  /**
   * Get cache statistics (for monitoring)
   */
  getStats(): { size: number; entries: number } {
    return {
      size: this.cache.size,
      entries: this.cache.size,
    };
  }
}




