import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private migrationsRun = false;

  async onModuleInit() {
    await this.$connect();
    
    // Automatically run migrations on startup in production
    if (process.env.NODE_ENV === 'production' && !this.migrationsRun) {
      await this.runMigrations();
    }
  }

  private async runMigrations() {
    try {
      this.logger.log('Checking database schema...');
      
      // First, try to push schema directly (works better for PostgreSQL)
      // This ensures tables exist even if migrations are incompatible
      try {
        const { stdout, stderr } = await execAsync('npx prisma db push --accept-data-loss', {
          cwd: process.cwd(),
          env: { ...process.env },
        });
        
        if (stdout) {
          this.logger.log(stdout);
        }
        if (stderr && !stderr.includes('already in sync')) {
          this.logger.warn(stderr);
        }
        
        this.logger.log('Database schema synchronized successfully');
        this.migrationsRun = true;
        return;
      } catch (dbPushError) {
        this.logger.warn('db push failed, trying migrate deploy...', dbPushError);
        
        // Fallback to migrate deploy if db push fails
        const { stdout, stderr } = await execAsync('npx prisma migrate deploy', {
          cwd: process.cwd(),
          env: { ...process.env },
        });
        
        if (stdout) {
          this.logger.log(stdout);
        }
        if (stderr && !stderr.includes('No pending migrations')) {
          this.logger.warn(stderr);
        }
        
        this.logger.log('Database migrations check completed');
        this.migrationsRun = true;
      }
    } catch (error) {
      this.logger.error('Failed to sync database schema:', error);
      this.logger.warn('Please run "npx prisma db push --accept-data-loss" manually to sync schema');
      // Don't throw - allow app to start even if schema sync fails
      // The error will be logged and can be handled manually
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
