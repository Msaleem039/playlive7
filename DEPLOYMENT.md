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
DATABASE_URL="postgresql://username:password@host:5432/database?sslmode=require"
DIRECT_URL="postgresql://username:password@host:5432/database?sslmode=require"
```

### 2. Run Database Migrations

**IMPORTANT:** You must run migrations before starting the application in production.

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

### Automatic Migration on Startup

The application will attempt to run migrations automatically on startup in production mode. However, it's recommended to run migrations manually before starting the application to avoid any issues.

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

