# Quick Fix: Production Database Connection Error

## Error
```
Can't reach database server at `placeholder:5432`
```

## Cause
The `DATABASE_URL` environment variable is not set in production, so Prisma is using a placeholder value.

## Quick Fix (5 minutes)

### Step 1: SSH into your production server
```bash
ssh root@srv1090600
# or your server credentials
```

### Step 2: Navigate to your backend directory
```bash
cd /var/www/backend
```

### Step 3: Check if .env file exists
```bash
ls -la .env
```

### Step 4: Create or update .env file

**Option A: If .env doesn't exist, create it:**
```bash
cp env.production.example .env
nano .env
```

**Option B: If .env exists, check if DATABASE_URL is set:**
```bash
cat .env | grep DATABASE_URL
```

If it shows `placeholder` or is missing, edit it:
```bash
nano .env
```

### Step 5: Update DATABASE_URL in .env

Replace the placeholder with your actual Neon database connection string:

```env
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xxx-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
DIRECT_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-xxx.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
```

**Get your connection string from:**
- Neon Console: https://console.neon.tech
- Go to your project → Connection Details
- Copy the connection string

### Step 6: Verify environment setup
```bash
node scripts/verify-production-env.js
```

This should show:
- ✅ .env file exists
- ✅ All required environment variables are set
- ✅ DATABASE_URL format is valid

### Step 7: Restart PM2 with environment file

**Option A: Using ecosystem config (recommended):**
```bash
pm2 stop backend
pm2 delete backend
pm2 start ecosystem.config.js
pm2 save
```

**Option B: Manual start with env file:**
```bash
pm2 stop backend
pm2 delete backend
pm2 start dist/main.js --name backend --env-file .env
pm2 save
```

### Step 8: Check logs
```bash
pm2 logs backend --lines 50
```

You should see:
- ✅ `Connecting to database: ep-xxx-pooler...`
- ✅ `Database connection established`

If you still see errors, check:
```bash
pm2 logs backend --err
```

## Verification

After restarting, verify the connection works:

```bash
# Check if database connection is successful
pm2 logs backend | grep -i "database\|connected\|error"

# Check PM2 status
pm2 status

# Check if the app is running
pm2 list
```

## Still Having Issues?

1. **Verify .env file is in the correct location:**
   ```bash
   pwd  # Should show /var/www/backend
   ls -la .env  # Should show the file
   ```

2. **Check file permissions:**
   ```bash
   chmod 600 .env  # Secure permissions
   ```

3. **Test database connection manually:**
   ```bash
   # Load environment
   source .env
   # Or
   export $(cat .env | xargs)
   
   # Test connection
   node -e "console.log(process.env.DATABASE_URL)"
   ```

4. **Check PM2 is loading .env:**
   ```bash
   pm2 env backend | grep DATABASE_URL
   ```

   If it shows `placeholder`, PM2 isn't loading the .env file. Use the ecosystem.config.js method instead.

## Prevention

To prevent this in the future:

1. **Always use ecosystem.config.js for PM2:**
   ```bash
   pm2 start ecosystem.config.js
   ```

2. **Verify environment before deploying:**
   ```bash
   npm run verify:env
   ```

3. **Keep .env file secure and never commit it to git**

