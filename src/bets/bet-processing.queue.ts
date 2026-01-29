import { Injectable, Logger } from '@nestjs/common';
import { Queue, QueueOptions } from 'bullmq';
import { RedisService } from '../common/redis/redis.service';

/**
 * ✅ PERFORMANCE: Bet Processing Queue
 * 
 * Handles background processing of heavy calculations after bet placement.
 * Uses BullMQ (Redis-based) for reliable job processing.
 */
@Injectable()
export class BetProcessingQueue {
  private readonly logger = new Logger(BetProcessingQueue.name);
  private queue: Queue;

  constructor(private readonly redisService: RedisService) {
    // Initialize queue with Redis connection
    // Use same Redis config as RedisService
    try {
      this.queue = new Queue('bet-processing', {
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          maxRetriesPerRequest: null, // Disable retries to reduce spam
          enableReadyCheck: false, // Don't wait for ready check
          lazyConnect: true, // Connect on demand
          retryStrategy: () => null, // Stop retrying immediately
          enableOfflineQueue: false, // Don't queue commands when offline
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 1000, // Keep max 1000 completed jobs
          },
          removeOnFail: {
            age: 86400, // Keep failed jobs for 24 hours
          },
        },
      });

      // Handle connection errors gracefully (reduce log spam)
      let connectionErrorLogged = false;
      this.queue.on('error', (err) => {
        const errorCode = (err as any)?.code || 'UNKNOWN';
        const errorMessage = err instanceof Error ? err.message : String(err);
        
        // Filter out common connection errors to reduce log spam
        const isConnectionError = 
          errorCode === 'ECONNREFUSED' || 
          errorMessage.includes('Connection is closed') ||
          errorMessage.includes('ECONNREFUSED');
        
        if (isConnectionError && !connectionErrorLogged) {
          this.logger.warn(
            'Redis not available for bet processing queue. ' +
            'Background processing will be unavailable until Redis is started. ' +
            'Bets will still be accepted (fast path).',
          );
          connectionErrorLogged = true;
        }
        // Silently ignore connection errors after first warning
      });

      this.logger.log('Bet Processing Queue initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize bet processing queue: ${error instanceof Error ? error.message : String(error)}. ` +
        'Background processing will be unavailable. Bets will still be accepted (fast path).',
      );
      // Create a dummy queue to prevent crashes
      this.queue = null as any;
    }
  }

  /**
   * ✅ PERFORMANCE: Add bet to background processing queue
   * Fire-and-forget - does not block response
   */
  async addBetProcessingJob(betId: string, betData: {
    userId: string;
    marketId: string;
    eventId: string | null;
    marketType: string;
    gtype: string;
    betType: string;
    betValue: number;
    betRate: number;
    selectionId: number;
    winAmount: number;
    lossAmount: number;
  }): Promise<void> {
    // ✅ Gracefully handle Redis unavailability
    if (!this.queue) {
      this.logger.debug(`Bet processing queue unavailable, skipping background job for ${betId}`);
      return;
    }

    try {
      await this.queue.add(
        'process-bet',
        {
          betId,
          ...betData,
        },
        {
          jobId: `bet-${betId}`, // Ensure idempotency
        },
      );
      this.logger.debug(`Bet processing job added: ${betId}`);
    } catch (error) {
      const errorCode = (error as any)?.code || 'UNKNOWN';
      // Only log non-connection errors to reduce spam
      if (errorCode !== 'ECONNREFUSED') {
        this.logger.warn(
          `Failed to add bet processing job for ${betId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Don't throw - job queue failure shouldn't block bet acceptance
    }
  }

  /**
   * ✅ PERFORMANCE: Add bet exposure processing job to queue
   * Fire-and-forget - does not block response
   * Worker will calculate real exposure, handle offsets, and adjust wallet
   */
  addBetExposureProcessingJob(betId: string, betData: {
    userId: string;
    walletId: string;
    marketId: string;
    matchId: string;
    eventId: string | null;
    rawGtype: string | null;
    betType: string;
    betName: string;
    marketName: string;
    marketType: string;
    betValue: number;
    betRate: number;
    selectionId: number;
    winAmount: number;
    lossAmount: number;
    maxPossibleLoss: number;
  }): void {
    // ✅ Gracefully handle Redis unavailability
    if (!this.queue) {
      this.logger.debug(`Bet processing queue unavailable, skipping exposure processing job for ${betId}`);
      return;
    }

    // ✅ FIRE-AND-FORGET: Don't await - use timeout to prevent blocking
    const queuePromise = this.queue.add(
      'process-bet-exposure',
      {
        betId,
        ...betData,
      },
      {
        jobId: `exposure-${betId}`, // Ensure idempotency
      },
    );

    // ✅ Set timeout to prevent blocking (100ms max wait)
    Promise.race([
      queuePromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Queue add timeout')), 100)
      ),
    ])
      .then(() => {
        this.logger.debug(`Bet exposure processing job added: ${betId}`);
      })
      .catch((error) => {
        const errorCode = (error as any)?.code || 'UNKNOWN';
        // Only log non-connection/timeout errors to reduce spam
        if (errorCode !== 'ECONNREFUSED' && !error.message?.includes('timeout')) {
          this.logger.warn(
            `Failed to add exposure processing job for ${betId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Silently continue - job will be added eventually or skipped
      });
  }

  /**
   * ✅ PERFORMANCE: Add position calculation job to queue
   * Fire-and-forget - does not block response
   */
  addPositionCalculationJob(betId: string, positionData: {
    userId: string;
    marketId: string;
    rawGtype: string | null;
  }): void {
    // ✅ Gracefully handle Redis unavailability
    if (!this.queue) {
      this.logger.debug(`Bet processing queue unavailable, skipping position calculation job for ${betId}`);
      return;
    }

    // ✅ FIRE-AND-FORGET: Don't await - use timeout to prevent blocking
    const queuePromise = this.queue.add(
      'calculate-positions',
      {
        betId,
        ...positionData,
      },
      {
        jobId: `position-${betId}`, // Ensure idempotency
      },
    );

    // ✅ Set timeout to prevent blocking (100ms max wait)
    Promise.race([
      queuePromise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Queue add timeout')), 100)
      ),
    ])
      .then(() => {
        this.logger.debug(`Position calculation job added: ${betId}`);
      })
      .catch((error) => {
        const errorCode = (error as any)?.code || 'UNKNOWN';
        // Only log non-connection/timeout errors to reduce spam
        if (errorCode !== 'ECONNREFUSED' && !error.message?.includes('timeout')) {
          this.logger.warn(
            `Failed to add position calculation job for ${betId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Silently continue - job will be added eventually or skipped
      });
  }

  /**
   * Get queue instance (for worker)
   */
  getQueue(): Queue {
    return this.queue;
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

