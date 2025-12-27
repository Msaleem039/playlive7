# Supabase Migration Guide

## 🎯 Overview

This guide explains how to handle database migrations with Supabase, which has specific limitations that require a different approach than standard PostgreSQL.

## ❌ Why Auto-Migrations Don't Work with Supabase

**Supabase Transaction Pooler (port 6543) limitations:**
- ❌ Does NOT support `PREPARE` statements
- ❌ Does NOT support Prisma migrations
- ❌ Does NOT support schema diffing
- ✅ **BUT** supports normal runtime queries perfectly

**This is why you see:**
```
Supabase Transaction Pooler does not support PREPARE statements
Transaction Pooler does not support Prisma migrations
```

## ✅ The Correct Approach

### Connection URLs Setup

```env
# Runtime (API queries) - Transaction Pooler
DATABASE_URL="postgresql://postgres.isdzyrpqrpmprnxanzdg:password@aws-1-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require"

# Migrations only - Session Pooler or Direct
DIRECT_URL="postgresql://postgres:password@db.isdzyrpqrpmprnxanzdg.supabase.co:5432/postgres?sslmode=require"
```

**Important:**
- ✅ `DATABASE_URL` = Transaction Pooler (port 6543) for runtime
- ✅ `DIRECT_URL` = Session Pooler (port 5432) for migrations only
- ⚠️ **Never use DIRECT_URL in running app** - only for CLI migrations

## 🚀 Running Migrations

### Option A: Supabase SQL Editor (Recommended ✅)

**Best for production and safest approach:**

1. **Generate SQL from Prisma schema:**
   ```bash
   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > schema.sql
   ```

2. **Or generate diff from existing migrations:**
   ```bash
   npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel prisma/schema.prisma --script > migration.sql
   ```

3. **Open Supabase Dashboard:**
   - Go to https://supabase.com/dashboard
   - Select your project
   - Navigate to **SQL Editor**

4. **Run the SQL:**
   - Copy contents from `schema.sql` or `migration.sql`
   - Paste into SQL Editor
   - Click **Run**

5. **Verify:**
   ```bash
   # Check tables exist
   DATABASE_URL="your-direct-url" npx prisma db pull
   ```

### Option B: CLI with DIRECT_URL (Local Development)

**Only use this for local development, not production:**

```bash
# Set DIRECT_URL temporarily for migration
export DATABASE_URL="postgresql://postgres:password@db.project.supabase.co:5432/postgres?sslmode=require"

# Run migration
npx prisma migrate deploy

# Or for new migrations
npx prisma migrate dev --name migration_name

# Restore original DATABASE_URL
unset DATABASE_URL
```

**Or use inline:**
```bash
DATABASE_URL="postgresql://postgres:password@db.project.supabase.co:5432/postgres?sslmode=require" npx prisma migrate deploy
```

## 📋 Migration Workflow

### Initial Setup

1. **Create schema in Prisma:**
   ```prisma
   // prisma/schema.prisma
   model User {
     id    Int    @id @default(autoincrement())
     email String @unique
   }
   ```

2. **Generate SQL:**
   ```bash
   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > initial-schema.sql
   ```

3. **Run in Supabase SQL Editor**

4. **Mark as applied (optional):**
   ```bash
   # Create migration record
   mkdir -p prisma/migrations/0_init
   echo "-- Migration applied manually in Supabase" > prisma/migrations/0_init/migration.sql
   ```

### Adding New Changes

1. **Update Prisma schema**

2. **Generate diff:**
   ```bash
   npx prisma migrate diff \
     --from-schema-datamodel prisma/schema.prisma \
     --to-schema-datamodel prisma/schema.prisma \
     --script > new-migration.sql
   ```

   Or compare with existing migrations:
   ```bash
   npx prisma migrate diff \
     --from-migrations ./prisma/migrations \
     --to-schema-datamodel prisma/schema.prisma \
     --script > new-migration.sql
   ```

3. **Review the SQL** in `new-migration.sql`

4. **Run in Supabase SQL Editor**

5. **Create migration record:**
   ```bash
   mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_migration_name
   cp new-migration.sql prisma/migrations/$(date +%Y%m%d%H%M%S)_migration_name/migration.sql
   ```

## 🔍 Verifying Migrations

### Check Current Schema

```bash
# Pull current schema from Supabase
DATABASE_URL="your-direct-url" npx prisma db pull

# Compare with your schema.prisma
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma
```

### Check Migration Status

```bash
# Using DIRECT_URL
DATABASE_URL="your-direct-url" npx prisma migrate status
```

## ⚠️ Common Issues

### Issue: "Transaction Pooler does not support PREPARE statements"

**Cause:** Trying to run migrations with Transaction Pooler URL

**Solution:** 
- Use SQL Editor (Option A) ✅
- Or use DIRECT_URL with Session Pooler (Option B)

### Issue: "No pending migrations" but schema is out of sync

**Cause:** Migrations were applied manually in SQL Editor, but Prisma doesn't know about them

**Solution:**
1. Generate migration record:
   ```bash
   mkdir -p prisma/migrations/0_manual
   echo "-- Applied manually in Supabase SQL Editor" > prisma/migrations/0_manual/migration.sql
   ```

2. Or use `prisma migrate resolve`:
   ```bash
   DATABASE_URL="your-direct-url" npx prisma migrate resolve --applied migration_name
   ```

### Issue: App starts but shows migration warnings

**This is expected and safe!** The app will work fine for runtime queries. The warnings just mean Prisma tried to check migrations but couldn't (because Transaction Pooler doesn't support it).

**Solution:** This is normal - ignore the warnings. Your app queries will work perfectly.

## 📚 Best Practices

1. ✅ **Always use SQL Editor for production migrations**
2. ✅ **Review SQL before running** - especially for destructive changes
3. ✅ **Keep migration records** - create migration folders even for manual migrations
4. ✅ **Test migrations locally first** - use a local Supabase instance or test project
5. ✅ **Never auto-migrate in production** - always manual, reviewed process
6. ✅ **Use Transaction Pooler for runtime** - better performance and connection handling
7. ✅ **Use Session Pooler/Direct for migrations only** - never in running app

## 🔗 Resources

- [Supabase Connection Pooling Docs](https://supabase.com/docs/guides/database/connecting-to-postgres#connection-pooler)
- [Prisma Migrate Docs](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Prisma with Supabase Guide](https://www.prisma.io/docs/guides/deployment/deployment-guides/deploying-to-supabase)










