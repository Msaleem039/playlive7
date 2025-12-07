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

    // Normalize connection string for Neon
    const normalizedUrl = this.normalizeConnectionString(dbUrl);
    if (normalizedUrl !== dbUrl) {
      this.logger.warn('Connection string normalized (removed problematic parameters)');
      process.env.DATABASE_URL = normalizedUrl;
    }

    try {
      const dbHost = normalizedUrl.split('@')[1]?.split('/')[0] || 'database';
      this.logger.log(`Connecting to database: ${dbHost}`);
      
      // Attempt connection with retry logic
      await this.connectWithRetry();
      this.isConnected = true;
      this.logger.log('✅ Database connection established');
    } catch (error) {
      this.logger.error('Failed to connect to database after retries');
      this.logger.error(`Error: ${error.message}`);
      this.logger.error(`Error Code: ${error.code || 'N/A'}`);
      
      // Provide helpful troubleshooting information
      this.logTroubleshootingTips(error);
      
      if (process.env.NODE_ENV === 'production') {
        throw error;
      } else {
        this.logger.warn('Application will continue without database connection (development mode)');
        this.logger.warn('Fix the connection issue and restart the application');
        return;
      }
    }
    
    // Automatically run migrations on startup in production
    // Can be skipped by setting SKIP_MIGRATIONS=true
    if (
      process.env.NODE_ENV === 'production' && 
      !this.migrationsRun &&
      process.env.SKIP_MIGRATIONS !== 'true'
    ) {
      await this.runMigrations();
    } else if (process.env.SKIP_MIGRATIONS === 'true') {
      this.logger.warn('⚠️  Schema migrations skipped (SKIP_MIGRATIONS=true)');
      this.logger.warn('Make sure to run migrations manually: npm run prisma:deploy');
    }
  }

  /**
   * Normalize connection string to fix common Neon connection issues
   */
  private normalizeConnectionString(url: string): string {
    try {
      const urlObj = new URL(url);
      
      // Remove channel_binding=require as it can cause connection issues
      urlObj.searchParams.delete('channel_binding');
      
      // Ensure sslmode is set (required for Neon)
      if (!urlObj.searchParams.has('sslmode')) {
        urlObj.searchParams.set('sslmode', 'require');
      }
      
      // Add connection timeout
      if (!urlObj.searchParams.has('connect_timeout')) {
        urlObj.searchParams.set('connect_timeout', '10');
      }
      
      return urlObj.toString();
    } catch (error) {
      // If URL parsing fails, return original
      this.logger.warn('Failed to parse connection string, using as-is');
      return url;
    }
  }

  /**
   * Connect to database with retry logic and exponential backoff
   */
  private async connectWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Set connection timeout
        await Promise.race([
          this.$connect(),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout after 10 seconds')), 10000)
          )
        ]);
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const delay = initialDelay * Math.pow(2, attempt - 1);
        
        if (attempt < maxRetries) {
          this.logger.warn(`Connection attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          this.logger.error(`All ${maxRetries} connection attempts failed`);
        }
      }
    }
    
    // This should never happen, but TypeScript needs this check
    if (!lastError) {
      throw new Error('Connection failed for unknown reason');
    }
    throw lastError;
  }

  /**
   * Log troubleshooting tips based on error type
   */
  private logTroubleshootingTips(error: any): void {
    this.logger.error('\n🔧 Troubleshooting Tips:');
    
    if (error.code === 'P1001' || error.message?.includes("Can't reach database server")) {
      this.logger.error('  • Network connectivity issue detected');
      this.logger.error('  • Check your internet connection');
      this.logger.error('  • Verify the database host is correct in DATABASE_URL');
      this.logger.error('  • Check if your firewall is blocking the connection');
      this.logger.error('  • Verify your Neon database is not paused');
      this.logger.error('  • Try using the direct connection URL instead of pooler');
      this.logger.error('  • Run: node scripts/test-neon-connection.js to test connection');
    } else if (error.code === 'P1000') {
      this.logger.error('  • Authentication failed');
      this.logger.error('  • Check your database username and password');
      this.logger.error('  • Verify credentials in Neon console');
    } else if (error.code === 'P1003') {
      this.logger.error('  • Database does not exist');
      this.logger.error('  • Verify the database name in your connection string');
    } else if (error.message?.includes('SSL') || error.message?.includes('TLS')) {
      this.logger.error('  • SSL/TLS connection issue');
      this.logger.error('  • Ensure sslmode=require is in your connection string');
      this.logger.error('  • Try removing channel_binding parameter');
    }
    
    this.logger.error('\n💡 Quick fixes:');
    this.logger.error('  1. Test connection: node scripts/test-neon-connection.js');
    this.logger.error('  2. Check .env file has correct DATABASE_URL');
    this.logger.error('  3. Verify Neon database is active in Neon Console');
    this.logger.error('  4. Try using direct connection URL (not pooler)');
    this.logger.error('');
  }

  private async runMigrations() {
    try {
      this.logger.log('Checking database migrations...');
      
      // First, quickly check if migrations table exists and if we need to run migrations
      // This is much faster than db push which does a full schema comparison
      try {
        const startTime = Date.now();
        
        // Use migrate deploy - it's faster as it only checks migration history
        // instead of comparing the entire schema
        const { stdout, stderr } = await execAsync('npx prisma migrate deploy', {
          cwd: process.cwd(),
          env: { ...process.env },
          timeout: 30000, // 30 second timeout
        });
        
        const duration = Date.now() - startTime;
        
        if (stdout) {
          // Only log if there's actual output (migrations were applied)
          if (!stdout.includes('No pending migrations')) {
            this.logger.log(stdout);
          }
        }
        if (stderr && !stderr.includes('No pending migrations') && !stderr.includes('already applied')) {
          this.logger.warn(stderr);
        }
        
        if (stdout?.includes('No pending migrations') || stderr?.includes('No pending migrations')) {
          this.logger.log(`✅ Database schema is up to date (${duration}ms)`);
        } else {
          this.logger.log(`✅ Database migrations applied successfully (${duration}ms)`);
        }
        
        this.migrationsRun = true;
        return;
      } catch (migrateError: any) {
        // If migrate deploy fails (e.g., no migrations table), try db push as fallback
        // This is slower but ensures schema exists
        if (migrateError.message?.includes('migration') || migrateError.code === 1) {
          this.logger.warn('Migration deploy failed, trying schema push as fallback...');
          this.logger.warn('Note: This may take longer as it compares the entire schema');
          
          try {
            const startTime = Date.now();
            const { stdout, stderr } = await execAsync('npx prisma db push --accept-data-loss --skip-generate', {
              cwd: process.cwd(),
              env: { ...process.env },
              timeout: 60000, // 60 second timeout for db push
            });
            
            const duration = Date.now() - startTime;
            
            if (stdout) {
              this.logger.log(stdout);
            }
            if (stderr && !stderr.includes('already in sync')) {
              this.logger.warn(stderr);
            }
            
            this.logger.log(`✅ Database schema synchronized (${duration}ms)`);
            this.migrationsRun = true;
            return;
          } catch (dbPushError) {
            this.logger.error('Both migrate deploy and db push failed');
            throw dbPushError;
          }
        } else {
          throw migrateError;
        }
      }
    } catch (error: any) {
      this.logger.error('Failed to sync database schema:', error.message || error);
      this.logger.warn('The application will continue, but you may need to run migrations manually:');
      this.logger.warn('  npm run prisma:deploy');
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
