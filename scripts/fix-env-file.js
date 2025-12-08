#!/usr/bin/env node

/**
 * Fix Production .env File
 * 
 * This script fixes common issues with .env files:
 * - Truncated DATABASE_URL lines
 * - Missing quotes
 * - Incomplete connection strings
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(process.cwd(), '.env');

// Correct .env content based on the user's credentials
const correctEnvContent = `NODE_ENV=production
PORT=3000

# JWT Configuration
# Generate a strong random secret for production (e.g., use: openssl rand -base64 32)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Database Configuration
# Prisma requires DATABASE_URL and DIRECT_URL for migrations when using pooler
#
# Neon Production Database
# Note: channel_binding=require can cause connection issues - it will be automatically removed
#
# IMPORTANT: For Neon, you need TWO different connection strings:
# 1. DATABASE_URL: Use the POOLER endpoint (recommended for serverless/regular connections)
#    - Hostname contains "-pooler" (e.g., ep-xxx-pooler.region.aws.neon.tech)
# 2. DIRECT_URL: Use the DIRECT endpoint (required for migrations like db push)
#    - Hostname does NOT contain "-pooler" (e.g., ep-xxx.region.aws.neon.tech)
#
# Get both connection strings from Neon Console:
# https://console.neon.tech -> Your Project -> Connection Details
#
# For pooler connections (recommended for serverless):
DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
# For direct connections (required for migrations - replace with your direct endpoint):
DIRECT_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
`;

function fixEnvFile() {
  console.log('🔧 Fixing .env file...\n');
  
  // Check if .env exists
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found!');
    console.error(`📁 Expected location: ${envPath}`);
    console.error('\n💡 Create it first: cp env.production.example .env');
    process.exit(1);
  }
  
  // Read current .env
  let currentContent = fs.readFileSync(envPath, 'utf8');
  
  // Check for truncated DATABASE_URL
  const hasTruncatedDbUrl = currentContent.includes('sslmode=re>') || 
                           !currentContent.includes('DATABASE_URL="postgresql://') ||
                           !currentContent.includes('?sslmode=require"');
  
  if (hasTruncatedDbUrl) {
    console.log('⚠️  Found truncated or incomplete DATABASE_URL');
    console.log('📝 Fixing .env file...\n');
    
    // Backup original
    const backupPath = `${envPath}.backup.${Date.now()}`;
    fs.writeFileSync(backupPath, currentContent);
    console.log(`💾 Backup created: ${backupPath}`);
    
    // Write corrected content
    fs.writeFileSync(envPath, correctEnvContent);
    console.log('✅ .env file fixed!\n');
    
    console.log('📋 Changes made:');
    console.log('   - Fixed truncated DATABASE_URL line');
    console.log('   - Ensured both DATABASE_URL and DIRECT_URL are complete');
    console.log('   - Verified connection string format\n');
  } else {
    console.log('✅ .env file looks correct');
    console.log('   No fixes needed\n');
  }
  
  // Verify the fix
  console.log('🔍 Verifying .env file...\n');
  const verifyContent = fs.readFileSync(envPath, 'utf8');
  
  // Check if DATABASE_URL is complete
  const dbUrlMatch = verifyContent.match(/DATABASE_URL="([^"]+)"/);
  if (dbUrlMatch) {
    const dbUrl = dbUrlMatch[1];
    if (dbUrl.includes('placeholder')) {
      console.error('❌ DATABASE_URL still contains placeholder!');
      console.error('   Please update with your actual database credentials');
      process.exit(1);
    }
    if (!dbUrl.endsWith('?sslmode=require')) {
      console.error('❌ DATABASE_URL is incomplete!');
      console.error('   Missing sslmode=require at the end');
      process.exit(1);
    }
    console.log('✅ DATABASE_URL is complete and valid');
  } else {
    console.error('❌ DATABASE_URL not found or malformed!');
    process.exit(1);
  }
  
  // Check DIRECT_URL
  const directUrlMatch = verifyContent.match(/DIRECT_URL="([^"]+)"/);
  if (directUrlMatch) {
    const directUrl = directUrlMatch[1];
    if (directUrl.includes('placeholder')) {
      console.error('❌ DIRECT_URL still contains placeholder!');
      process.exit(1);
    }
    if (!directUrl.endsWith('?sslmode=require')) {
      console.error('❌ DIRECT_URL is incomplete!');
      process.exit(1);
    }
    console.log('✅ DIRECT_URL is complete and valid');
  } else {
    console.error('❌ DIRECT_URL not found or malformed!');
    process.exit(1);
  }
  
  console.log('\n✅ .env file is now correct!');
  console.log('\n📝 Next steps:');
  console.log('   1. Restart PM2: pm2 restart backend');
  console.log('   2. Check logs: pm2 logs backend');
  console.log('   3. Verify connection: Look for "Database connection established" in logs');
}

fixEnvFile();

