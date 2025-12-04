#!/usr/bin/env node

/**
 * Environment Setup Helper
 * 
 * This script copies the example environment file to .env
 * 
 * Usage:
 *   node scripts/switch-db.js
 */

const fs = require('fs');
const path = require('path');

const envFile = 'env.production.example';
const targetFile = '.env';

if (!fs.existsSync(envFile)) {
  console.error(`❌ Environment file ${envFile} not found!`);
  console.error('Please ensure env.production.example exists in the project root.');
  process.exit(1);
}

if (fs.existsSync(targetFile)) {
  console.log('⚠️  Warning: .env file already exists!');
  console.log('This will overwrite your existing .env file.');
  console.log('If you want to keep your current .env, press Ctrl+C now.');
  console.log('');
}

try {
  fs.copyFileSync(envFile, targetFile);
  console.log(`✅ Created .env file from ${envFile}`);
  console.log(`📁 Location: ${path.join(process.cwd(), targetFile)}`);
  console.log('');
  console.log('⚠️  IMPORTANT: Update the values in .env with your actual database credentials!');
  console.log('   - Update DATABASE_URL with your database connection string');
  console.log('   - Update JWT_SECRET with a strong random secret');
  console.log('   - Set NODE_ENV to "development" or "production" as needed');
} catch (error) {
  console.error(`❌ Error creating .env file: ${error.message}`);
  process.exit(1);
}
