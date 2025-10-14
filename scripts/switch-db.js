#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const dbType = process.argv[2];

if (!dbType || !['neon', 'local', 'production'].includes(dbType)) {
  console.log('Usage: node scripts/switch-db.js [neon|local|production]');
  console.log('');
  console.log('Examples:');
  console.log('  node scripts/switch-db.js neon     # Switch to Neon database');
  console.log('  node scripts/switch-db.js local    # Switch to local PostgreSQL');
  console.log('  node scripts/switch-db.js production # Switch to production config');
  process.exit(1);
}

const envFile = `env.${dbType}.example`;
const targetFile = '.env';

if (!fs.existsSync(envFile)) {
  console.error(`Environment file ${envFile} not found!`);
  process.exit(1);
}

try {
  fs.copyFileSync(envFile, targetFile);
  console.log(`✅ Switched to ${dbType} database configuration`);
  console.log(`📁 Copied ${envFile} to ${targetFile}`);
  console.log('');
  console.log('⚠️  Remember to update the values in .env with your actual database credentials');
} catch (error) {
  console.error(`❌ Error switching database configuration: ${error.message}`);
  process.exit(1);
}

