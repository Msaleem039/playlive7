import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      // OPTIMIZED: Connection pooling configuration for better performance
      datasources: {
        db: {
          url: process.env.DATABASE_URL,
        },
      },
      // Log only errors in production, queries in development
      log: process.env.NODE_ENV === 'production' 
        ? ['error'] 
        : ['query', 'info', 'warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
