# Production .env File Checklist

## Required Variables

Your production `.env` file must have these variables:

### 1. NODE_ENV
```bash
NODE_ENV=production
```

### 2. JWT_SECRET
```bash
JWT_SECRET=your-strong-random-secret-key-here
```
**Important:** Generate a strong secret:
```bash
openssl rand -base64 32
```

### 3. DATABASE_URL
```bash
DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```
✅ You already have this!

## Optional (but recommended)

### 4. DIRECT_URL
```bash
DIRECT_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```
Used for migrations (can be same as DATABASE_URL)

### 5. PORT
```bash
PORT=3000
```
Defaults to 3000 if not set

## Complete Production .env Example

```bash
NODE_ENV=production
PORT=3000

# JWT Configuration
JWT_SECRET=your-strong-random-secret-generated-with-openssl

# Database Configuration
DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
DIRECT_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```

## Quick Check Commands

On your production server, run:

```bash
# Check if all required vars are set
cat .env | grep -E "^(NODE_ENV|JWT_SECRET|DATABASE_URL)="

# View current DATABASE_URL (password hidden)
cat .env | grep DATABASE_URL | sed 's/:[^:@]*@/:****@/'

# Check if JWT_SECRET is set
if grep -q "^JWT_SECRET=" .env; then
  echo "✅ JWT_SECRET is set"
else
  echo "❌ JWT_SECRET is missing!"
fi
```

