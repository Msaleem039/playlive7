#!/usr/bin/env node

/**
 * Verify Production Environment Setup
 * 
 * This script checks if all required environment variables are set
 * and provides helpful error messages if they're missing.
 */

const fs = require('fs');
const path = require('path');

// Required environment variables
const requiredVars = [
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
  'NODE_ENV',
];

// Optional but recommended
const recommendedVars = [
  'PORT',
];

function checkEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found!');
    console.error(`📁 Expected location: ${envPath}`);
    console.error('\n💡 To create it:');
    console.error('   1. Copy the example: cp env.production.example .env');
    console.error('   2. Or run: npm run setup:env');
    console.error('   3. Edit .env with your actual database credentials');
    return false;
  }
  
  console.log('✅ .env file exists');
  return true;
}

function checkEnvVars() {
  // Load .env file
  require('dotenv').config();
  
  const missing = [];
  const warnings = [];
  
  // Check required variables
  for (const varName of requiredVars) {
    const value = process.env[varName];
    if (!value || value.includes('placeholder')) {
      missing.push(varName);
    }
  }
  
  // Check recommended variables
  for (const varName of recommendedVars) {
    if (!process.env[varName]) {
      warnings.push(varName);
    }
  }
  
  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:');
    missing.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    
    if (missing.includes('DATABASE_URL') || missing.includes('DIRECT_URL')) {
      console.error('\n💡 Database Configuration:');
      console.error('   Get your database connection string from:');
      console.error('   - Neon Console: https://console.neon.tech');
      console.error('   - Your hosting provider dashboard');
      console.error('\n   Format: postgresql://username:password@host:5432/database?sslmode=require');
    }
    
    return false;
  }
  
  if (warnings.length > 0) {
    console.warn('\n⚠️  Recommended environment variables not set:');
    warnings.forEach(varName => {
      console.warn(`   - ${varName} (will use default value)`);
    });
  }
  
  console.log('\n✅ All required environment variables are set');
  return true;
}

function validateDatabaseUrl() {
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    return false;
  }
  
  // Check if it's a placeholder
  if (dbUrl.includes('placeholder')) {
    console.error('\n❌ DATABASE_URL contains placeholder value!');
    console.error('   Please update .env with your actual database connection string');
    return false;
  }
  
  // Basic validation
  if (!dbUrl.startsWith('postgresql://')) {
    console.error('\n❌ DATABASE_URL format is invalid!');
    console.error('   Expected format: postgresql://username:password@host:port/database');
    return false;
  }
  
  console.log('✅ DATABASE_URL format is valid');
  
  // Extract host for display (without password)
  try {
    const url = new URL(dbUrl);
    const host = url.hostname;
    console.log(`   Database host: ${host}`);
  } catch (e) {
    // Ignore parsing errors
  }
  
  return true;
}

function main() {
  console.log('🔍 Verifying Production Environment Setup\n');
  
  const envFileExists = checkEnvFile();
  if (!envFileExists) {
    process.exit(1);
  }
  
  const envVarsOk = checkEnvVars();
  if (!envVarsOk) {
    process.exit(1);
  }
  
  const dbUrlValid = validateDatabaseUrl();
  if (!dbUrlValid) {
    process.exit(1);
  }
  
  console.log('\n✅ Environment setup is correct!');
  console.log('\n📝 Next steps:');
  console.log('   1. Restart PM2: pm2 restart backend');
  console.log('   2. Check logs: pm2 logs backend');
  console.log('   3. Verify connection: Check PM2 logs for database connection messages');
}

main();

