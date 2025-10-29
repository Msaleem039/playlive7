import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { InMemoryCacheService } from './in-memory-cache.service';
import { RedisController } from './redis.controller';

@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        // Try to use Redis if available, otherwise fallback to memory
        try {
          const redisStore = require('cache-manager-redis-store');
          return {
            store: redisStore,
            host: configService.get<string>('REDIS_HOST') || 'localhost',
            port: configService.get<number>('REDIS_PORT') || 6379,
            password: configService.get<string>('REDIS_PASSWORD'),
            db: configService.get<number>('REDIS_DB') || 0,
            ttl: 300, // Default TTL: 5 minutes
            max: 1000, // Maximum number of items in cache
          };
        } catch (error) {
          // Fallback to memory store if Redis is not available
          console.log('⚠️ Redis not available, using in-memory cache');
          return {
            ttl: 300,
            max: 1000,
          };
        }
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [RedisController],
  providers: [
    {
      provide: RedisService,
      useClass: InMemoryCacheService, // Use in-memory cache as fallback
    },
    InMemoryCacheService,
  ],
  exports: [CacheModule, RedisService, InMemoryCacheService],
})
export class RedisModule {}
