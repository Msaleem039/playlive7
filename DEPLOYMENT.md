# Production Deployment Guide

## Database Setup

### 1. Create `.env` File

Create a `.env` file in the project root with your production database credentials:

```bash
# Copy example file
cp env.production.example .env
```

Then edit `.env` and update with your actual values:

```env
NODE_ENV=production
PORT=3000

# JWT Configuration
JWT_SECRET=your-strong-random-secret-key-here

# Database Configuration
# Runtime connection (for app queries) - use Transaction Pooler for Supabase
DATABASE_URL="postgresql://postgres.isdzyrpqrpmprnxanzdg:password@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require"

# Direct connection (for migrations only) - use Session Pooler or direct endpoint
# ⚠️ NEVER use DIRECT_URL in running app - only for CLI migrations
DIRECT_URL="postgresql://postgres:password@db.isdzyrpqrpmprnxanzdg.supabase.co:5432/postgres?sslmode=require"
```

### 2. Run Database Migrations

**IMPORTANT:** You must run migrations before starting the application in production.

#### For Supabase (Recommended)

**⚠️ Supabase Transaction Pooler (port 6543) does NOT support Prisma migrations.**

**✅ Use Supabase SQL Editor (BEST for Supabase):**

1. Generate your schema SQL:
   ```bash
   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > schema.sql
   ```

2. Copy the generated SQL from `schema.sql`

3. Open Supabase Dashboard → SQL Editor

4. Paste and run the SQL

**✅ OR use DIRECT_URL for CLI migrations (local development only):**

```bash
# Use DIRECT_URL (Session Pooler on port 5432) for migrations
DATABASE_URL="postgresql://postgres:password@db.project.supabase.co:5432/postgres?sslmode=require" npx prisma migrate deploy
```

#### For Other Databases (Neon, Standard PostgreSQL)

```bash
# Option 1: Using npm script
npm run prisma:deploy

# Option 2: Using the migration script
node scripts/run-migrations.js

# Option 3: Direct Prisma command
npx prisma migrate deploy
```

This will create all required tables:
- `users`
- `wallets`
- `matches`
- `bets`
- `transactions`
- `transfer_transactions`
- `transfer_logs`

### 3. Generate Prisma Client

After running migrations, generate the Prisma client:

```bash
npm run prisma:generate
```

### 4. Build and Start Application

```bash
# Build the application
npm run build

# Start in production mode
npm run start:prod

# OR using PM2
pm2 start dist/main.js --name nest-app
```

## Troubleshooting

### Error: "The table `main.bets` does not exist"

This means migrations haven't been run. Follow these steps:

1. **Check if `.env` exists and has correct DATABASE_URL:**
   ```bash
   cat .env | grep DATABASE_URL
   ```

2. **Run migrations:**
   ```bash
   npm run prisma:deploy
   ```

3. **Regenerate Prisma client:**
   ```bash
   npm run prisma:generate
   ```

4. **Restart the application:**
   ```bash
   pm2 restart nest-app
   ```

### Error: "DATABASE_URL is not set" or "Can't reach database server at `placeholder:5432`"

This means the `DATABASE_URL` environment variable is not set or PM2 is not loading the `.env` file.

**Solution:**

1. **Verify `.env` file exists and has correct values:**
   ```bash
   # Check if .env exists
   ls -la .env
   
   # View DATABASE_URL (be careful, this shows password)
   cat .env | grep DATABASE_URL
   ```

2. **Run verification script:**
   ```bash
   node scripts/verify-production-env.js
   ```

3. **If `.env` is missing or has placeholder values:**
   ```bash
   # Copy example file
   cp env.production.example .env
   
   # Edit with your actual database credentials
   nano .env
   # or
   vi .env
   ```

4. **Restart PM2 with environment file:**
   ```bash
   # Stop current process
   pm2 stop backend
   pm2 delete backend
   
   # Start with ecosystem config (loads .env automatically)
   pm2 start ecosystem.config.js
   
   # Or start manually with env file
   pm2 start dist/main.js --name backend --env-file .env
   
   # Check logs
   pm2 logs backend
   ```

5. **Verify environment is loaded:**
   ```bash
   # Check if DATABASE_URL is loaded (should NOT show placeholder)
   pm2 logs backend | grep DATABASE_URL
   ```

### ⚠️ Important: No Automatic Migrations on Startup

**The application does NOT run migrations automatically on startup.** This is intentional and follows best practices:

- ✅ **Production apps should never auto-migrate** - migrations should be run manually as part of deployment
- ✅ **Supabase Transaction Pooler doesn't support migrations** - requires Session Pooler or SQL Editor
- ✅ **Better control and safety** - manual migrations allow for review and rollback

**Always run migrations manually before starting the application:**
- For Supabase: Use SQL Editor (recommended) or DIRECT_URL
- For other databases: Use `npm run prisma:deploy`

## Quick Deployment Checklist

- [ ] `.env` file created with correct `DATABASE_URL`
- [ ] Database migrations run (`npm run prisma:deploy`)
- [ ] Prisma client generated (`npm run prisma:generate`)
- [ ] Application built (`npm run build`)
- [ ] Application started (`npm run start:prod` or PM2)

## PM2 Configuration

The project includes an `ecosystem.config.js` file for PM2. This ensures environment variables are loaded correctly.

### Using PM2 with Ecosystem Config

```bash
# Start application with ecosystem config
pm2 start ecosystem.config.js

# Or start with specific environment
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

### PM2 Commands

```bash
# Start application (using ecosystem config - recommended)
pm2 start ecosystem.config.js

# Or start manually
pm2 start dist/main.js --name backend --env-file .env

# View logs
pm2 logs backend

# View error logs only
pm2 logs backend --err

# Restart application
pm2 restart backend

# Stop application
pm2 stop backend

# View status
pm2 status

# Delete from PM2
pm2 delete backend
```

## Verify Environment Setup

Before starting the application, verify your environment is configured correctly:

```bash
# Verify environment variables are set
node scripts/verify-production-env.js
```

This script will check:
- ✅ `.env` file exists
- ✅ All required environment variables are set
- ✅ `DATABASE_URL` format is valid
- ✅ No placeholder values are used

