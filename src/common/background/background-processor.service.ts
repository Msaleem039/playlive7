import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * ✅ PERFORMANCE OPTIMIZATION: Background Processor Service
 * 
 * Handles async post-response processing for:
 * - Position calculations
 * - PnL recalculations
 * - Hierarchy PnL distribution
 * - Cache invalidation
 * 
 * ⚠️ CRITICAL: This does NOT change business logic - only execution timing.
 * All calculations remain identical, only moved to background.
 */
@Injectable()
export class BackgroundProcessorService {
  private readonly logger = new Logger(BackgroundProcessorService.name);
  private readonly processingQueue = new Set<string>(); // Track in-flight tasks

  constructor(private readonly redisService: RedisService) {}

  /**
   * ✅ PERFORMANCE: Fire-and-forget async processing
   * Executes task without blocking response
   */
  private async executeAsync<T>(
    taskName: string,
    taskId: string,
    task: () => Promise<T>,
  ): Promise<void> {
    // Prevent duplicate processing
    if (this.processingQueue.has(taskId)) {
      this.logger.debug(`Task ${taskName} (${taskId}) already in progress, skipping`);
      return;
    }

    this.processingQueue.add(taskId);

    // Execute asynchronously (fire-and-forget)
    task()
      .then(() => {
        this.logger.debug(`Background task ${taskName} (${taskId}) completed successfully`);
      })
      .catch((error) => {
        this.logger.error(
          `Background task ${taskName} (${taskId}) failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.processingQueue.delete(taskId);
      });
  }

  /**
   * ✅ PERFORMANCE: Process position calculation after bet placement
   * Non-blocking, fire-and-forget
   */
  processPositionAfterBet(
    userId: string,
    marketId: string,
    eventId: string | null,
    marketType: string,
  ): void {
    const taskId = `position:${userId}:${marketId}:${Date.now()}`;
    
    this.executeAsync('position-calculation', taskId, async () => {
      // Position calculation will be handled by the positions controller
      // This just invalidates cache to trigger recalculation on next GET
      await this.redisService.invalidateUserPositions(userId);
    }).catch(() => {
      // Silently fail - position calculation is non-critical
    });
  }

  /**
   * ✅ PERFORMANCE: Process PnL recalculation after settlement
   * Non-blocking, fire-and-forget
   * 
   * @param processor - Function that handles both PnL recalculation and hierarchy distribution
   */
  processPnLAfterSettlement(
    userId: string,
    eventId: string,
    marketType: string,
    processor: () => Promise<void>,
  ): void {
    const taskId = `pnl:${userId}:${eventId}:${marketType}:${Date.now()}`;
    
    this.executeAsync('pnl-recalculation', taskId, processor).catch(() => {
      // Logged but don't block
    });
  }

  /**
   * ✅ PERFORMANCE: Invalidate all caches for a user after bet/settlement
   * Non-blocking, fire-and-forget
   */
  invalidateUserCaches(userId: string, eventId?: string): void {
    const taskId = `cache-invalidate:${userId}:${Date.now()}`;
    
    this.executeAsync('cache-invalidation', taskId, async () => {
      await Promise.all([
        this.redisService.invalidateUserPositions(userId),
        this.redisService.invalidateUserExposure(userId),
        eventId ? this.redisService.invalidateUserPnl(userId, eventId) : Promise.resolve(),
      ]);
    }).catch(() => {
      // Silently fail - cache invalidation is non-critical
    });
  }

  /**
   * ✅ PERFORMANCE: Batch process multiple users
   * Non-blocking, fire-and-forget
   */
  batchProcessUsers(
    userIds: string[],
    processor: (userId: string) => Promise<void>,
  ): void {
    const taskId = `batch:${userIds.length}:${Date.now()}`;
    
    this.executeAsync('batch-processing', taskId, async () => {
      // Process in parallel but with concurrency limit
      const concurrency = 10;
      for (let i = 0; i < userIds.length; i += concurrency) {
        const batch = userIds.slice(i, i + concurrency);
        await Promise.allSettled(
          batch.map((userId) =>
            processor(userId).catch((err) => {
              this.logger.warn(`Failed to process user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
            }),
          ),
        );
      }
    }).catch(() => {
      // Logged but don't block
    });
  }
}

