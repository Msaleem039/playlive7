import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Cap Prisma pool size for Supabase pooler (session pool default max is often 15). */
function buildRuntimeDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  const isPoolerHost = url.hostname.includes('.pooler.supabase.com');
  const port = url.port || '5432';

  // Transaction pooler (6543) — recommended for Prisma runtime.
  if (isPoolerHost && port === '5432' && !url.searchParams.has('pgbouncer')) {
    url.port = '6543';
    url.searchParams.set('pgbouncer', 'true');
  }

  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', '5');
  }

  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', '20');
  }

  return url.toString();
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      datasources: {
        db: {
          url: buildRuntimeDatabaseUrl(),
        },
      },
      log:
        process.env.NODE_ENV === 'development'
          ? ['warn', 'error']
          : ['error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
