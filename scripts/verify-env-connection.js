#!/usr/bin/env node

/**
 * Verify .env file and test database connection
 * This script checks:
 * 1. .env file exists
 * 2. Required variables are present
 * 3. Connection string format is valid
 * 4. Database connection works
 */

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const envPath = path.join(process.cwd(), '.env');

console.log('🔍 Verifying .env file and database connection...\n');

// Step 1: Check if .env exists
if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found!');
  console.error(`   Expected location: ${envPath}`);
  console.error('\n   To create one:');
  console.error('   1. Copy env.production.template to .env');
  console.error('   2. Update with your actual credentials');
  process.exit(1);
}

console.log('✅ .env file exists');

// Step 2: Load .env file
require('dotenv').config({ path: envPath });

// Step 3: Check required variables
const requiredVars = [
  'NODE_ENV',
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
];

const missingVars = [];
const presentVars = [];

for (const varName of requiredVars) {
  const value = process.env[varName];
  if (!value || value.trim() === '') {
    missingVars.push(varName);
  } else {
    presentVars.push(varName);
    // Show partial value for security (first 20 chars)
    const displayValue = value.length > 20 
      ? value.substring(0, 20) + '...' 
      : value.substring(0, 10) + '***';
    console.log(`✅ ${varName}: ${displayValue}`);
  }
}

if (missingVars.length > 0) {
  console.error('\n❌ Missing required environment variables:');
  missingVars.forEach(v => console.error(`   - ${v}`));
  process.exit(1);
}

// Step 4: Validate connection string format
console.log('\n📋 Validating connection string format...');

const dbUrl = process.env.DATABASE_URL;
const directUrl = process.env.DIRECT_URL;

function validateConnectionString(url, name) {
  if (!url) {
    console.error(`❌ ${name} is empty`);
    return false;
  }

  if (!url.startsWith('postgresql://')) {
    console.error(`❌ ${name} must start with "postgresql://"`);
    return false;
  }

  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname || !urlObj.pathname) {
      console.error(`❌ ${name} has invalid format`);
      return false;
    }

    // Check if it's a Neon connection string
    const isNeon = urlObj.hostname.includes('neon.tech') || 
                   urlObj.hostname.includes('neon.tech');
    
    if (isNeon) {
      const isPooler = urlObj.hostname.includes('pooler');
      console.log(`   ${name}: Neon ${isPooler ? 'Pooler' : 'Direct'} connection`);
    } else {
      console.log(`   ${name}: Custom PostgreSQL connection`);
    }

    // Check for sslmode
    const sslMode = urlObj.searchParams.get('sslmode');
    if (!sslMode) {
      console.warn(`   ⚠️  ${name}: Missing sslmode parameter (should be "require" for Neon)`);
    } else {
      console.log(`   ${name}: sslmode=${sslMode}`);
    }

    // Extract hostname (without showing full credentials)
    const hostPart = url.split('@')[1]?.split('/')[0] || 'unknown';
    console.log(`   ${name}: Host: ${hostPart.split(':')[0]}`);

    return true;
  } catch (error) {
    console.error(`❌ ${name} has invalid URL format: ${error.message}`);
    return false;
  }
}

const dbUrlValid = validateConnectionString(dbUrl, 'DATABASE_URL');
const directUrlValid = validateConnectionString(directUrl, 'DIRECT_URL');

if (!dbUrlValid || !directUrlValid) {
  console.error('\n❌ Connection string validation failed');
  process.exit(1);
}

// Step 5: Test database connection
console.log('\n🔌 Testing database connection...');

async function testConnection() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: dbUrl,
      },
    },
  });

  try {
    console.log('   Attempting to connect...');
    
    // Set a timeout for connection
    const connectionPromise = prisma.$connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout after 10 seconds')), 10000)
    );

    await Promise.race([connectionPromise, timeoutPromise]);
    
    console.log('✅ Database connection successful!');
    
    // Test a simple query
    console.log('   Testing query...');
    await prisma.$queryRaw`SELECT 1 as test`;
    console.log('✅ Query test successful!');
    
    await prisma.$disconnect();
    console.log('\n✅ All checks passed! Your .env file is correctly configured.');
    return true;
  } catch (error) {
    console.error('\n❌ Database connection failed!');
    console.error(`   Error: ${error.message}`);
    
    if (error.code === 'P1000') {
      console.error('\n   🔑 Authentication Error (P1000):');
      console.error('   This means your username or password is incorrect.');
      console.error('   Please check:');
      console.error('   1. Username in connection string');
      console.error('   2. Password in connection string');
      console.error('   3. If password has special characters, make sure they are URL-encoded');
      console.error('   4. Verify credentials in Neon Console');
    } else if (error.code === 'P1001') {
      console.error('\n   🌐 Connection Error (P1001):');
      console.error('   Cannot reach database server.');
      console.error('   Please check:');
      console.error('   1. Hostname is correct');
      console.error('   2. Network connectivity');
      console.error('   3. Firewall settings');
    } else if (error.message.includes('timeout')) {
      console.error('\n   ⏱️  Connection Timeout:');
      console.error('   Database server is not responding.');
      console.error('   Please check:');
      console.error('   1. Hostname is correct');
      console.error('   2. Port is correct (usually 5432)');
      console.error('   3. Database server is running');
    }
    
    await prisma.$disconnect().catch(() => {});
    return false;
  }
}

// Run the test
testConnection()
  .then((success) => {
    process.exit(success ? 0 : 1);
  })
  .catch((error) => {
    console.error('\n❌ Unexpected error:', error.message);
    process.exit(1);
  });


