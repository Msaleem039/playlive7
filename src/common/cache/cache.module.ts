import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * ✅ PERFORMANCE OPTIMIZATION: Cache Module
 * 
 * Provides caching infrastructure for performance optimization.
 * Does NOT change business logic - only caches results.
 */
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}




