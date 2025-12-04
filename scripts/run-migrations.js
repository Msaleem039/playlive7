#!/usr/bin/env node

/**
 * Migration Runner Script
 * 
 * This script runs Prisma migrations on the production database.
 * Run this script after deploying to ensure the database schema is up to date.
 * 
 * Usage:
 *   node scripts/run-migrations.js
 *   OR
 *   npm run prisma:deploy
 */

const { execSync } = require('child_process');
const path = require('path');

console.log('🚀 Running database migrations...\n');

try {
  // Change to project root directory
  process.chdir(path.join(__dirname, '..'));
  
  // Check if .env exists
  const fs = require('fs');
  if (!fs.existsSync('.env')) {
    console.error('❌ Error: .env file not found!');
    console.error('Please create a .env file with your DATABASE_URL before running migrations.');
    process.exit(1);
  }

  // Run migrations
  console.log('📦 Deploying Prisma migrations...');
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  console.log('\n✅ Database migrations completed successfully!');
  
  // Regenerate Prisma client
  console.log('\n🔄 Regenerating Prisma client...');
  execSync('npx prisma generate', {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  console.log('\n✅ Prisma client regenerated successfully!');
  console.log('\n🎉 All database setup completed!');
  
} catch (error) {
  console.error('\n❌ Error running migrations:', error.message);
  console.error('\nPlease check:');
  console.error('1. DATABASE_URL is set correctly in .env');
  console.error('2. Database is accessible');
  console.error('3. You have proper permissions');
  process.exit(1);
}

