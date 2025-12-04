#!/usr/bin/env node

/**
 * Test Neon database connection
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function testConnection() {
  console.log('🔍 Testing Neon Database Connection...\n');
  
  // Check if DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set in .env file!');
    console.log('\n💡 To fix this:');
    console.log('   1. Run: npm run create:env');
    console.log('   2. Or manually create .env file with DATABASE_URL');
    process.exit(1);
  }

  // Check if it's a placeholder
  if (process.env.DATABASE_URL.includes('placeholder')) {
    console.error('❌ DATABASE_URL is set to placeholder value!');
    console.log('\n💡 To fix this:');
    console.log('   1. Edit .env file');
    console.log('   2. Set DATABASE_URL to your Neon connection string');
    process.exit(1);
  }

  console.log('✅ DATABASE_URL is set');
  console.log('📡 Connection string:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  console.log('\n🔄 Attempting to connect...\n');

  const prisma = new PrismaClient();

  try {
    // Test connection
    await prisma.$connect();
    console.log('✅ Successfully connected to Neon database!');
    
    // Test a simple query
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log('✅ Database query test passed');
    
    // Check if tables exist
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `;
    
    console.log('\n📊 Database Tables:');
    if (tables.length === 0) {
      console.log('   ⚠️  No tables found. Run migrations: npm run prisma:deploy');
    } else {
      tables.forEach(table => {
        console.log(`   ✓ ${table.table_name}`);
      });
    }
    
    console.log('\n🎉 Database connection is working correctly!');
    console.log('\n💡 Next steps:');
    console.log('   1. Restart your application: npm run start:dev');
    console.log('   2. The JWT errors should be resolved');
    
  } catch (error) {
    console.error('❌ Failed to connect to database:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('   1. Check your DATABASE_URL in .env file');
    console.log('   2. Verify your Neon database is running');
    console.log('   3. Check your network connection');
    console.log('   4. Verify database credentials are correct');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();

