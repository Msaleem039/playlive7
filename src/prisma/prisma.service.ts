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
      this.logger.log('Checking database migrations...');
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
    } catch (error) {
      this.logger.error('Failed to run database migrations:', error);
      this.logger.warn('Please run "npm run prisma:deploy" manually to apply migrations');
      // Don't throw - allow app to start even if migrations fail
      // The error will be logged and can be handled manually
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
