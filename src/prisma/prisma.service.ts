import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private migrationsRun = false;
  private isConnected = false;

  constructor() {
    // PrismaClient requires DATABASE_URL at instantiation
    // If not set in development, use a placeholder that won't actually connect
    const originalDbUrl = process.env.DATABASE_URL;
    if (!originalDbUrl) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production. Please set it in your .env file.');
      }
      // Use a placeholder URL for development (PrismaClient needs it, but we won't connect)
      process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@placeholder:5432/placeholder';
    }
    super();
    
    // Log warning after super() call
    if (!originalDbUrl && process.env.NODE_ENV !== 'production') {
      this.logger.warn('DATABASE_URL not set - PrismaClient initialized with placeholder (will not connect)');
      this.logger.warn('To connect to your Neon database, create .env file: cp env.production.example .env');
    }
  }

  async onModuleInit() {
    // Check if DATABASE_URL is set and valid (not placeholder)
    const dbUrl = process.env.DATABASE_URL;
    
    if (!dbUrl || dbUrl.includes('placeholder')) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error('DATABASE_URL is required in production!');
        throw new Error('DATABASE_URL environment variable is not set');
      } else {
        this.logger.warn('DATABASE_URL not set - skipping database connection (development mode)');
        this.logger.warn('To connect to your Neon database, create .env file with DATABASE_URL');
        this.logger.warn('Example: cp env.production.example .env');
        return;
      }
    }

    try {
      const dbHost = dbUrl.split('@')[1]?.split('/')[0] || 'database';
      this.logger.log(`Connecting to database: ${dbHost}`);
      await this.$connect();
      this.isConnected = true;
      this.logger.log('✅ Database connection established');
    } catch (error) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error('Failed to connect to database:', error);
        throw error;
      } else {
        this.logger.warn('Failed to connect to database (development mode):', error);
        this.logger.warn('Make sure your DATABASE_URL in .env is correct');
        return;
      }
    }
    
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
    if (this.isConnected) {
      await this.$disconnect();
    }
  }

  /**
   * Check if the database is connected
   * @returns true if database is connected, false otherwise
   */
  isDatabaseConnected(): boolean {
    return this.isConnected;
  }
}
