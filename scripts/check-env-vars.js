#!/usr/bin/env node

/**
 * Quick script to check if environment variables are set
 * Run this on production to verify .env file is correct
 */

require('dotenv').config();

console.log('🔍 Checking Environment Variables\n');

const required = {
  'NODE_ENV': process.env.NODE_ENV,
  'DATABASE_URL': process.env.DATABASE_URL,
  'DIRECT_URL': process.env.DIRECT_URL,
  'JWT_SECRET': process.env.JWT_SECRET,
};

const optional = {
  'PORT': process.env.PORT || '3000 (default)',
};

let allGood = true;

console.log('📋 Required Variables:');
console.log('─'.repeat(50));
for (const [key, value] of Object.entries(required)) {
  if (!value || value.includes('placeholder')) {
    console.log(`❌ ${key}: ${value ? 'placeholder detected' : 'NOT SET'}`);
    allGood = false;
  } else {
    // Mask password in connection strings
    const displayValue = key.includes('URL') 
      ? value.replace(/:([^:@]+)@/, ':****@')
      : key === 'JWT_SECRET' 
        ? (value.length > 20 ? value.substring(0, 20) + '...' : '****')
        : value;
    console.log(`✅ ${key}: ${displayValue}`);
  }
}

console.log('\n📋 Optional Variables:');
console.log('─'.repeat(50));
for (const [key, value] of Object.entries(optional)) {
  console.log(`ℹ️  ${key}: ${value}`);
}

console.log('\n' + '─'.repeat(50));

if (allGood) {
  console.log('✅ All required environment variables are set correctly!');
  process.exit(0);
} else {
  console.log('❌ Some required environment variables are missing or invalid!');
  console.log('\n💡 Fix:');
  console.log('   1. Check your .env file: cat .env');
  console.log('   2. Make sure DIRECT_URL is set (required by Prisma schema)');
  console.log('   3. Restart PM2: pm2 restart backend');
  process.exit(1);
}

