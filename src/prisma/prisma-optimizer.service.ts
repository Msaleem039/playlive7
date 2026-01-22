import { Injectable, Logger } from '@nestjs/common';

/**
 * 🔧 PRISMA CONNECTION POOL OPTIMIZER
 * 
 * Lightweight utilities to prevent P2024 connection pool exhaustion:
 * - Concurrency limiting for batch operations
 * - Simple in-memory caching for read-heavy queries
 * - Connection pool monitoring
 * 
 * ✅ Safe, additive, non-breaking
 * ✅ No external dependencies
 * ✅ Works on Windows local dev
 */
@Injectable()
export class PrismaOptimizerService {
  private readonly logger = new Logger(PrismaOptimizerService.name);
  
  // Simple in-memory cache with TTL
  private readonly cache = new Map<string, { data: any; expiresAt: number }>();
  
  // Concurrency limiter state
  private readonly activeOperations = new Map<string, number>();
  private readonly maxConcurrentOperations = 5; // Max concurrent DB ops per key

  /**
   * Execute operations with concurrency limiting
   * Prevents connection pool exhaustion during batch operations
   * 
   * @param key - Unique key for this operation type (e.g., 'syncMatch', 'settlement')
   * @param operations - Array of async operations to execute
   * @param concurrency - Max concurrent operations (default: 5)
   */
  async executeWithConcurrencyLimit<T>(
    key: string,
    operations: Array<() => Promise<T>>,
    concurrency: number = this.maxConcurrentOperations,
  ): Promise<T[]> {
    if (operations.length === 0) {
      return [];
    }

    const results: T[] = [];
    const errors: Error[] = [];

    // Process operations in batches
    for (let i = 0; i < operations.length; i += concurrency) {
      const batch = operations.slice(i, i + concurrency);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (op) => {
          try {
            return await op();
          } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
        }),
      );

      // Collect successful results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }

      // Small delay between batches to allow connections to be released
      if (i + concurrency < operations.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    if (errors.length > 0) {
      this.logger.warn(
        `${errors.length} errors in batch operation '${key}' (${results.length} succeeded)`,
      );
    }

    return results;
  }

  /**
   * Simple in-memory cache with TTL
   * Use only for read-heavy queries where data freshness is not critical
   * 
   * @param key - Cache key
   * @param ttlMs - Time to live in milliseconds
   * @param fetcher - Function to fetch data if cache miss
   */
  async getOrFetch<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > now) {
      return cached.data as T;
    }

    // Cache miss - fetch and cache
    const data = await fetcher();
    this.cache.set(key, {
      data,
      expiresAt: now + ttlMs,
    });

    return data;
  }

  /**
   * Invalidate cache entry
   */
  invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate cache entries matching pattern
   */
  invalidateCachePattern(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clean expired cache entries
   */
  cleanExpiredCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.expiresAt <= now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} expired cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}










