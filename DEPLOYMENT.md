# Production Deployment Guide

## Database Setup

### 1. Create `.env` File

Create a `.env` file in the project root with your production database credentials:

```bash
# Copy example file
cp env.neon.example .env
# OR
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

### Error: "DATABASE_URL is not set"

Make sure your `.env` file exists and contains the `DATABASE_URL` variable.

### Automatic Migration on Startup

The application will attempt to run migrations automatically on startup in production mode. However, it's recommended to run migrations manually before starting the application to avoid any issues.

## Quick Deployment Checklist

- [ ] `.env` file created with correct `DATABASE_URL`
- [ ] Database migrations run (`npm run prisma:deploy`)
- [ ] Prisma client generated (`npm run prisma:generate`)
- [ ] Application built (`npm run build`)
- [ ] Application started (`npm run start:prod` or PM2)

## PM2 Commands

```bash
# Start application
pm2 start dist/main.js --name nest-app

# View logs
pm2 logs nest-app

# Restart application
pm2 restart nest-app

# Stop application
pm2 stop nest-app

# View status
pm2 status
```

