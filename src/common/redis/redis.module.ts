import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * ✅ PERFORMANCE OPTIMIZATION: Redis Module
 * 
 * Global module providing Redis caching infrastructure.
 * Does NOT change business logic - only provides caching layer.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}




