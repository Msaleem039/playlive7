import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * ✅ PERFORMANCE OPTIMIZATION: Redis Service
 * 
 * Provides Redis caching infrastructure for:
 * - Vendor API response caching
 * - User position/exposure/PnL snapshot invalidation
 * - High-performance data access
 * 
 * Gracefully handles Redis unavailability (continues without cache).
 */


@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD || undefined,

      // ✅ MUST for BullMQ & cache
      maxRetriesPerRequest: null,
      enableReadyCheck: true, // ✅ Enable ready check for eager connection
      lazyConnect: false, // ✅ Connect eagerly on startup (not lazily)

      // ✅ allow reconnect
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      },
    });

    this.client.on('ready', () => {
      this.logger.log('Redis connected and ready');
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis error: ${err.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    // ✅ Ensure connection is established eagerly
    try {
      await this.client.ping();
      this.logger.log('Redis connection verified');
    } catch (error) {
      this.logger.warn('Redis connection check failed, will retry on first use');
    }
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  // ---------- CACHE API (NON BLOCKING) ----------

  get<T>(key: string): Promise<T | null> {
    return this.client
      .get(key)
      .then(v => (v ? JSON.parse(v) : null))
      .catch(() => null);
  }

  async set(key: string, value: any, ttl = 30): Promise<void> {
    try {
      const payload = JSON.stringify(value);

      if (ttl > 0) {
        await this.client.set(key, payload, 'EX', ttl);
      } else {
        await this.client.set(key, payload);
      }
    } catch (error) {
      // Log error but don't throw - cache is optional
      this.logger.warn(`Redis set failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`);
      throw error; // Re-throw so caller can handle if needed
    }
  }

  del(key: string): void {
    this.client.del(key).catch(() => {});
  }

  // ❌ REMOVED: delPattern() - Redis KEYS command is blocking and causes latency
  // Use explicit key deletion instead: del(`user:${userId}:positions`)

  // ---------- VENDOR CACHE KEYS ----------

  /**
   * Generate vendor cache key
   */
  getVendorKey(type: string, eventId: string): string {
    return `vendor:${type}:${eventId}`;
  }

  // ---------- USER CACHE INVALIDATION ----------

  /**
   * Generate user positions cache key
   */
  private getUserPositionsKey(userId: string): string {
    return `user:${userId}:positions`;
  }

  /**
   * Generate user exposure cache key
   */
  private getUserExposureKey(userId: string): string {
    return `user:${userId}:exposure`;
  }

  /**
   * Generate user PnL cache key
   */
  private getUserPnlKey(userId: string, eventId: string): string {
    return `user:${userId}:pnl:${eventId}`;
  }

  /**
   * Invalidate user positions cache
   */
  async invalidateUserPositions(userId: string): Promise<void> {
    const key = this.getUserPositionsKey(userId);
    this.del(key);
  }

  /**
   * Invalidate user exposure cache
   */
  async invalidateUserExposure(userId: string): Promise<void> {
    const key = this.getUserExposureKey(userId);
    this.del(key);
  }

  /**
   * Invalidate user PnL cache for a specific event
   */
  async invalidateUserPnl(userId: string, eventId: string): Promise<void> {
    const key = this.getUserPnlKey(userId, eventId);
    this.del(key);
  }
}

