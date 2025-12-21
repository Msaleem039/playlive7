# Supabase Database Setup Instructions

## Problem
Supabase **Transaction Pooler** doesn't support:
- PREPARE statements (used by Prisma migrations)
- DDL statements (CREATE TABLE, CREATE TYPE, etc.)

## Solution: Use Session Pooler for Schema Creation

### Step 1: Get Session Pooler Connection String

1. Go to Supabase Dashboard → **Settings** → **Database**
2. Click on **Connection String** tab
3. Change **Method** from "Transaction pooler" to **"Session pooler"**
4. Copy the Session Pooler connection string
   - It should look like: `postgresql://postgres.isdzyrpqrpmprnxanzdg:[PASSWORD]@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require`
   - Note: Port is still 6543, but it's Session Pooler (not Transaction)

### Step 2: Update .env File

Update your `DIRECT_URL` to use Session Pooler:

```env
# For regular queries (Transaction Pooler - faster)
DATABASE_URL="postgresql://postgres.isdzyrpqrpmprnxanzdg:playlive7%40786@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require"

# For migrations/schema (Session Pooler - supports DDL)
DIRECT_URL="postgresql://postgres.isdzyrpqrpmprnxanzdg:playlive7%40786@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true"
```

**OR** use Supabase SQL Editor (Easier):

### Alternative: Use Supabase SQL Editor

1. Go to Supabase Dashboard → **SQL Editor**
2. Click **New Query**
3. Copy and paste the SQL from `schema.sql` file
4. Click **Run** to execute

This will create all tables directly in Supabase.

### Step 3: Run Prisma Migrations

After updating DIRECT_URL to Session Pooler:

```bash
npx prisma db push
```

Or if using SQL Editor, just verify:

```bash
npx prisma db pull  # This will sync your Prisma schema with the database
```

## Quick Fix: Copy SQL to Supabase

The easiest way right now:

1. Open `schema.sql` file
2. Copy all the SQL
3. Go to Supabase Dashboard → SQL Editor
4. Paste and Run

This will create all tables immediately!

