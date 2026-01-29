import { Module } from '@nestjs/common';
import { BackgroundProcessorService } from './background-processor.service';
import { RedisModule } from '../redis/redis.module';

/**
 * ✅ PERFORMANCE OPTIMIZATION: Background Processor Module
 * 
 * Provides async processing for non-critical operations.
 * Does NOT change business logic - only execution timing.
 */
@Module({
  imports: [RedisModule],
  providers: [BackgroundProcessorService],
  exports: [BackgroundProcessorService],
})
export class BackgroundProcessorModule {}




