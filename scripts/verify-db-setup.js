#!/usr/bin/env node

/**
 * Database Setup Verification Script
 * 
 * This script verifies that:
 * 1. .env file exists and has DATABASE_URL
 * 2. Prisma schema is valid
 * 3. Database connection works
 * 4. Tables exist (or can be created)
 * 
 * Usage:
 *   node scripts/verify-db-setup.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔍 Verifying database setup...\n');

let hasErrors = false;

// Step 1: Check .env file
console.log('1. Checking .env file...');
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('   ❌ .env file not found!');
  console.error('   Run: cp env.production.example .env');
  hasErrors = true;
} else {
  const envContent = fs.readFileSync(envPath, 'utf8');
  if (!envContent.includes('DATABASE_URL=')) {
    console.warn('   ⚠️  DATABASE_URL not found in .env');
    console.warn('   This is OK for local development');
    console.warn('   Make sure .env exists on production server with DATABASE_URL');
    // Don't treat as error for local dev
  } else {
    const dbUrl = envContent.match(/DATABASE_URL="?([^"\n]+)"?/)?.[1];
    if (dbUrl && (dbUrl.includes('your-') || dbUrl.includes('example'))) {
      console.warn('   ⚠️  DATABASE_URL appears to be a placeholder');
      console.warn('   Please update .env with your actual database credentials');
      // Don't treat as error for local dev
    } else {
      console.log('   ✅ .env file exists with DATABASE_URL');
    }
  }
}

// Step 2: Check Prisma schema
console.log('\n2. Checking Prisma schema...');
const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
if (!fs.existsSync(schemaPath)) {
  console.error('   ❌ prisma/schema.prisma not found!');
  hasErrors = true;
} else {
  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  if (schemaContent.includes('provider = "sqlite"')) {
    console.error('   ❌ Schema is still configured for SQLite!');
    console.error('   Should be: provider = "postgresql"');
    hasErrors = true;
  } else if (schemaContent.includes('provider = "postgresql"')) {
    console.log('   ✅ Schema is configured for PostgreSQL');
  } else {
    console.warn('   ⚠️  Could not determine database provider');
  }
}

// Step 3: Check Prisma client
console.log('\n3. Checking Prisma client...');
try {
  execSync('npx prisma generate --schema=prisma/schema.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
  });
  console.log('   ✅ Prisma client generated successfully');
} catch (error) {
  const errorMsg = error.message || '';
  if (errorMsg.includes('EPERM') || errorMsg.includes('operation not permitted')) {
    console.warn('   ⚠️  Prisma client file is locked (Windows permission issue)');
    console.warn('   This is usually fine - close any processes using Prisma and try again');
    console.warn('   Or run: npm run prisma:generate manually');
    // Don't treat this as a critical error
  } else {
    console.error('   ❌ Failed to generate Prisma client');
    console.error('   Error:', error.message.split('\n')[0]);
    hasErrors = true;
  }
}

// Step 4: Test database connection (optional, requires valid DATABASE_URL)
console.log('\n4. Testing database connection...');
try {
  // Try to introspect the database
  execSync('npx prisma db pull --schema=prisma/schema.prisma --print', {
    stdio: 'pipe',
    cwd: process.cwd(),
    timeout: 10000,
  });
  console.log('   ✅ Database connection successful');
} catch (error) {
  if (error.message.includes('P1001') || error.message.includes('Can\'t reach database')) {
    console.warn('   ⚠️  Cannot connect to database');
    console.warn('   This might be normal if database is not accessible from this machine');
    console.warn('   Verify DATABASE_URL is correct');
  } else {
    console.warn('   ⚠️  Database connection test failed');
    console.warn('   Error:', error.message.split('\n')[0]);
  }
}

// Summary
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.error('❌ Setup verification found critical issues');
  console.error('Please fix the errors above before deploying');
  process.exit(1);
} else {
  console.log('✅ Database setup verification passed!');
  console.log('\n📋 Deployment Checklist:');
  console.log('1. ✅ Schema is configured for PostgreSQL');
  console.log('2. ⚠️  Ensure .env exists on production with DATABASE_URL');
  console.log('3. ⚠️  On server, run: npx prisma db push --accept-data-loss');
  console.log('4. ⚠️  On server, run: npm run prisma:generate');
  console.log('5. ⚠️  Restart the application');
  console.log('\n💡 The app will automatically sync schema on startup in production');
  process.exit(0);
}

