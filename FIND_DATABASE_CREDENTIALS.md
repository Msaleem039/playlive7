# How to Find Your Database Credentials

## Where to Find Database Credentials

### 1. Hostinger Database Panel

If you're using Hostinger's database service:

1. **Log into Hostinger Control Panel (hPanel)**
2. **Go to Databases section**
3. **Click on your database** (or create one if it doesn't exist)
4. **You'll see:**
   - Database Name
   - Database Username
   - Database Password (click "Show" to reveal)
   - Database Host (usually `localhost` or an IP address)
   - Database Port (usually `3306` for MySQL or `5432` for PostgreSQL)

### 2. Neon Database (PostgreSQL)

If you're using Neon:

1. **Log into Neon Console** (https://console.neon.tech)
2. **Select your project**
3. **Go to Connection Details**
4. **Copy the connection string** - it will look like:
   ```
   postgresql://username:password@ep-xxx-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

### 3. Other Database Providers

**Supabase:**
- Dashboard → Project Settings → Database → Connection String

**AWS RDS:**
- RDS Console → Databases → Select your database → Connectivity & security

**DigitalOcean:**
- Databases → Select your database → Connection Details

**Railway:**
- Project → Database → Connect → Connection URL

## Creating .env File

Once you have your credentials, you can:

### Option 1: Use the Setup Script
```bash
node scripts/setup-env.js
```

### Option 2: Manual Creation

Create a `.env` file in the project root:

```env
NODE_ENV=production
PORT=3000

JWT_SECRET=your-strong-random-secret-key-here

# For PostgreSQL (Neon, Supabase, etc.)
DATABASE_URL="postgresql://username:password@host:5432/database?sslmode=require"
DIRECT_URL="postgresql://username:password@host:5432/database?sslmode=require"

# For MySQL/MariaDB (if using)
# DATABASE_URL="mysql://username:password@host:3306/database"
```

### Option 3: Copy from Example

```bash
cp env.neon.example .env
# Then edit .env with your actual credentials
nano .env
```

## Common Database Connection Formats

### PostgreSQL
```
postgresql://username:password@host:5432/database?sslmode=require
```

### MySQL/MariaDB
```
mysql://username:password@host:3306/database
```

### SQLite (Local Development)
```
file:./dev.db
```

## Security Notes

⚠️ **IMPORTANT:**
- Never commit `.env` files to git
- Keep your database credentials secure
- Use strong passwords
- Rotate credentials regularly
- Use environment-specific credentials (dev/staging/prod)

## Testing Your Connection

After creating `.env`, test the connection:

```bash
# Test with Prisma
npx prisma db pull

# Or test migrations
npm run prisma:deploy
```

If you get connection errors, double-check:
- Host address is correct
- Port number is correct
- Username and password are correct
- Database name exists
- Firewall allows connections from your server IP

