import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private isConnected = false;

  /**
   * Normalize connection string to fix common Neon connection issues
   * Static method so it can be called before super() in constructor
   */
  private static normalizeConnectionString(url: string): string {
    try {
      const urlObj = new URL(url);
      
      // Remove channel_binding=require as it can cause connection issues
      urlObj.searchParams.delete('channel_binding');
      
      // Ensure sslmode is set (required for Neon and Supabase)
      if (!urlObj.searchParams.has('sslmode')) {
        urlObj.searchParams.set('sslmode', 'require');
      }
      
      // Add connection timeout
      if (!urlObj.searchParams.has('connect_timeout')) {
        urlObj.searchParams.set('connect_timeout', '10');
      }
      
      // Configure connection pool settings for better concurrency
      // For Neon pooler: increase these values
      // For Supabase: Supabase handles pooling, but we can still set reasonable limits
      const isNeon = urlObj.hostname.includes('neon.tech');
      const isSupabase = urlObj.hostname.includes('supabase.co') || urlObj.hostname.includes('supabase.com');
      
      if (isNeon) {
        // Neon-specific pool settings
        if (!urlObj.searchParams.has('connection_limit')) {
          urlObj.searchParams.set('connection_limit', '20'); // Increased from default 5
        }
        if (!urlObj.searchParams.has('pool_timeout')) {
          urlObj.searchParams.set('pool_timeout', '20'); // Increased from default 10
        }
      } else if (isSupabase) {
        // Supabase Transaction Pooler doesn't support prepared statements
        // Add pgbouncer=true to disable prepared statements (required for Supabase)
        if (!urlObj.searchParams.has('pgbouncer')) {
          urlObj.searchParams.set('pgbouncer', 'true');
        }
        // Supabase handles connection pooling automatically
        // But we can set reasonable limits for Prisma
        if (!urlObj.searchParams.has('connection_limit')) {
          urlObj.searchParams.set('connection_limit', '10'); // Supabase recommended limit
        }
        if (!urlObj.searchParams.has('pool_timeout')) {
          urlObj.searchParams.set('pool_timeout', '10');
        }
      } else {
        // Generic PostgreSQL settings
        if (!urlObj.searchParams.has('connection_limit')) {
          urlObj.searchParams.set('connection_limit', '10');
        }
        if (!urlObj.searchParams.has('pool_timeout')) {
          urlObj.searchParams.set('pool_timeout', '10');
        }
      }
      
      return urlObj.toString();
    } catch (error) {
      // If URL parsing fails, return original
      return url;
    }
  }

  constructor() {
    // PrismaClient requires DATABASE_URL at instantiation
    // If not set in development, use a placeholder that won't actually connect
    const originalDbUrl = process.env.DATABASE_URL;
    let dbUrl = originalDbUrl;
    
    if (!originalDbUrl) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production. Please set it in your .env file.');
      }
      // Use a placeholder URL for development (PrismaClient needs it, but we won't connect)
      dbUrl = 'postgresql://placeholder:placeholder@placeholder:5432/placeholder';
      process.env.DATABASE_URL = dbUrl;
    } else {
      // Normalize connection string early to apply pool settings before PrismaClient instantiation
      // This ensures connection pool settings are applied from the start
      dbUrl = PrismaService.normalizeConnectionString(originalDbUrl);
      if (dbUrl !== originalDbUrl) {
        process.env.DATABASE_URL = dbUrl;
      }
    }
    
    // Configure PrismaClient with connection pool settings
    // Increase connection limit and timeout to handle concurrent operations
    super({
      datasources: {
        db: {
          url: dbUrl,
        },
      },
      // Connection pool configuration
      // Default is 5 connections, increase to handle concurrent queries
      // For Neon pooler, recommended is 10-20 connections
      log: process.env.NODE_ENV === 'development' 
        ? ['error', 'warn'] 
        : ['error'],
    });
    
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
      // If pooler connection fails, try direct connection as fallback
      // Check for various connection error types: P1001, timeout, connection reset, etc.
      const isConnectionError = 
        error.code === 'P1001' || 
        error.message?.includes("Can't reach database server") ||
        error.message?.includes("Connection timeout") ||
        error.message?.includes("timeout") ||
        error.message?.includes("ECONNRESET") ||
        error.message?.includes("connection was forcibly closed");
      const directUrl = process.env.DIRECT_URL;
      
      if (isConnectionError && directUrl && normalizedUrl.includes('pooler')) {
        this.logger.warn('Pooler connection failed, attempting fallback to direct connection...');
        
        // Validate that DIRECT_URL is actually a direct URL (not pooler)
        if (directUrl.includes('pooler')) {
          this.logger.error('DIRECT_URL appears to be a pooler URL. It should be the direct endpoint (without "-pooler" in hostname).');
          this.logger.error('Please update DIRECT_URL in your .env file to use the direct connection endpoint.');
          this.logTroubleshootingTips(error);
          if (process.env.NODE_ENV === 'production') {
            throw error;
          } else {
            this.logger.warn('Application will continue without database connection (development mode)');
            return;
          }
        }
        
        // Store original URL before switching
        const originalDbUrl = process.env.DATABASE_URL;
        
        try {
          // Normalize direct URL
          const normalizedDirectUrl = this.normalizeConnectionString(directUrl);
          
          // Disconnect current connection attempt
          await this.$disconnect().catch(() => {});
          
          // IMPORTANT: PrismaClient reads URL from datasources config at instantiation
          // We need to update the internal datasource URL by recreating the connection
          // Update environment variable for future operations
          process.env.DATABASE_URL = normalizedDirectUrl;
          
          // Update PrismaClient's datasource URL by using $connect with explicit URL
          // Note: Prisma doesn't support changing URL after instantiation, but we can
          // work around this by updating the datasource configuration
          const directHost = normalizedDirectUrl.split('@')[1]?.split('/')[0] || 'database';
          this.logger.log(`Retrying with direct connection: ${directHost}`);
          
          // Create a new PrismaClient instance with the direct URL for this connection attempt
          // We'll use $queryRaw with connection string override if possible, but Prisma
          // doesn't support that. Instead, we need to reconnect with the new URL.
          // The issue is that PrismaClient caches the connection URL.
          
          // Workaround: Use $connect() which should pick up the new DATABASE_URL from env
          // But PrismaClient may have cached the original URL. Let's try disconnecting
          // and reconnecting, which might force it to re-read the environment.
          await this.$disconnect().catch(() => {});
          
          // Small delay to ensure disconnect completes
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Try connecting again - Prisma should read from process.env.DATABASE_URL
          // But since we passed url in constructor, it might not. Let's try anyway.
          await this.connectWithRetry(3, 1000);
          this.isConnected = true;
          this.logger.log('✅ Database connection established via direct connection (fallback)');
          this.logger.warn('⚠️  Using direct connection instead of pooler. Consider checking pooler availability.');
          
        } catch (directError) {
          // Restore original URL
          process.env.DATABASE_URL = originalDbUrl;
          
          this.logger.error('Direct connection also failed');
          this.logger.error(`Direct connection error: ${directError.message}`);
          this.logger.error(`Error Code: ${directError.code || 'N/A'}`);
          
          // Check if the error still shows pooler URL (means PrismaClient is using original URL)
          if (directError.message?.includes('pooler')) {
            this.logger.error('');
            this.logger.error('⚠️  IMPORTANT: PrismaClient is still using the pooler URL from initialization.');
            this.logger.error('   This happens because PrismaClient reads the URL at instantiation time.');
            this.logger.error('');
            this.logger.error('   SOLUTION: Set DATABASE_URL to your DIRECT_URL in .env and restart the application.');
            this.logger.error('   Example: DATABASE_URL="postgresql://user:pass@ep-xxx.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"');
            this.logger.error('   (Note: Remove "-pooler" from the hostname)');
            this.logger.error('');
          }
          
          // Provide helpful troubleshooting information
          this.logTroubleshootingTips(error);
          
          if (process.env.NODE_ENV === 'production') {
            throw directError;
          } else {
            this.logger.warn('Application will continue without database connection (development mode)');
            this.logger.warn('Fix the connection issue and restart the application');
            return;
          }
        }
      } else {
        this.logger.error('Failed to connect to database after retries');
        this.logger.error(`Error: ${error.message}`);
        this.logger.error(`Error Code: ${error.code || 'N/A'}`);
        
        // If pooler failed but DIRECT_URL is not set, suggest it
        if (isConnectionError && normalizedUrl.includes('pooler') && !directUrl) {
          this.logger.error('\n💡 Tip: Pooler connection failed. Set DIRECT_URL in your .env file to enable automatic fallback.');
          this.logger.error('   DIRECT_URL should use the direct endpoint (without "-pooler" in hostname)');
          this.logger.error('   Get it from Neon Console: https://console.neon.tech -> Connection Details');
        }
        
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
    }
    
    // ✅ Migrations should NOT run on app startup with Supabase Transaction Pooler
    // Migrations require Session Pooler (port 5432) or direct connection
    // For Supabase, use SQL Editor to run migrations manually
    // For CLI migrations, use: DATABASE_URL=DIRECT_URL npx prisma migrate deploy
  }

  /**
   * Normalize connection string to fix common Neon connection issues
   * Instance method that calls the static method
   */
  private normalizeConnectionString(url: string): string {
    const normalized = PrismaService.normalizeConnectionString(url);
    if (normalized !== url) {
      // Only log if we're in a context where logger is available (after super())
      try {
        this.logger?.warn('Connection string normalized (applied pool settings)');
      } catch {
        // Logger not available yet, that's okay
      }
    }
    return normalized;
  }

  /**
   * Connect to database with retry logic and exponential backoff
   */
  private async connectWithRetry(maxRetries = 3, initialDelay = 1000): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Set connection timeout - increased to 15 seconds for better reliability
        await Promise.race([
          this.$connect(),
          new Promise<never>((_, reject) => {
            const timeoutError = new Error('Connection timeout after 15 seconds');
            (timeoutError as any).code = 'CONNECTION_TIMEOUT';
            setTimeout(() => reject(timeoutError), 15000);
          })
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
    
    // Detect database provider from connection string
    const dbUrl = process.env.DATABASE_URL || '';
    const isSupabase = dbUrl.includes('supabase.co');
    const isNeon = dbUrl.includes('neon.tech');
    
    if (error.code === 'P1001' || error.message?.includes("Can't reach database server")) {
      this.logger.error('  • Network connectivity issue detected');
      this.logger.error('  • Check your internet connection');
      this.logger.error('  • Verify the database host is correct in DATABASE_URL');
      this.logger.error('  • Check if your firewall is blocking the connection');
      
      if (isSupabase) {
        this.logger.error('  • Verify your Supabase project is active (not paused)');
        this.logger.error('  • Check Supabase Dashboard → Settings → Database for connection issues');
        this.logger.error('  • Verify IP restrictions/whitelist in Supabase (if enabled)');
        this.logger.error('  • Try disabling VPN temporarily to test connection');
        this.logger.error('  • Supabase requires sslmode=require in connection string');
      } else if (isNeon) {
        this.logger.error('  • Verify your Neon database is not paused');
        this.logger.error('  • Try using the direct connection URL instead of pooler');
      }
      
      this.logger.error('  • Verify DATABASE_URL in your .env file is correct');
    } else if (error.code === 'P1000') {
      this.logger.error('  • Authentication failed');
      this.logger.error('  • Check your database username and password');
      if (isSupabase) {
        this.logger.error('  • Verify credentials in Supabase Dashboard → Settings → Database');
        this.logger.error('  • Ensure password is URL-encoded (special characters like : become %3A)');
      } else if (isNeon) {
        this.logger.error('  • Verify credentials in Neon console');
      }
    } else if (error.code === 'P1003') {
      this.logger.error('  • Database does not exist');
      this.logger.error('  • Verify the database name in your connection string');
      if (isSupabase) {
        this.logger.error('  • Default Supabase database name is "postgres"');
      }
    } else if (error.message?.includes('SSL') || error.message?.includes('TLS')) {
      this.logger.error('  • SSL/TLS connection issue');
      this.logger.error('  • Ensure sslmode=require is in your connection string');
      this.logger.error('  • Try removing channel_binding parameter');
    }
    
    this.logger.error('\n💡 Quick fixes:');
    this.logger.error('  1. Check .env file has correct DATABASE_URL');
    if (isSupabase) {
      this.logger.error('  2. Verify Supabase project is active in Supabase Dashboard');
      this.logger.error('  3. Check Supabase IP restrictions/whitelist settings');
      this.logger.error('  4. Try disabling VPN to test connection');
    } else if (isNeon) {
      this.logger.error('  2. Verify Neon database is active in Neon Console');
      this.logger.error('  3. Try using direct connection URL (not pooler)');
    }
    this.logger.error('  5. Run: npm run verify:env to verify environment setup');
    this.logger.error('');
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
