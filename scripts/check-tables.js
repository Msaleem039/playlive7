const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function checkTables() {
  try {
    console.log('🔍 Checking if database tables exist...\n');
    
    await prisma.$connect();
    console.log('✅ Connected to database\n');
    
    // Get all tables
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    
    const tableNames = tables.map(t => t.table_name);
    
    console.log(`📋 Found ${tableNames.length} tables in database:\n`);
    
    if (tableNames.length === 0) {
      console.log('❌ NO TABLES FOUND!\n');
      console.log('⚠️  You need to create the tables first.\n');
      console.log('📝 Solution:');
      console.log('   1. Open Supabase Dashboard → SQL Editor');
      console.log('   2. Copy the SQL from schema.sql file');
      console.log('   3. Paste and Run in SQL Editor\n');
      return;
    }
    
    // Expected tables from schema
    const expectedTables = [
      'users',
      'wallets', 
      'matches',
      'bets',
      'transactions',
      'transfer_transactions',
      'transfer_logs',
      'settlements',
      'user_pnl',
      'hierarchy_pnl'
    ];
    
    console.log('Tables found:');
    tableNames.forEach(table => {
      const isExpected = expectedTables.includes(table);
      console.log(`   ${isExpected ? '✅' : '⚠️ '} ${table}`);
    });
    
    console.log('\n📊 Missing tables:');
    const missing = expectedTables.filter(t => !tableNames.includes(t));
    if (missing.length === 0) {
      console.log('   ✅ All expected tables exist!');
    } else {
      missing.forEach(table => {
        console.log(`   ❌ ${table}`);
      });
      console.log('\n⚠️  You need to create the missing tables.');
      console.log('   Run the SQL from schema.sql in Supabase SQL Editor.');
    }
    
    // Check for enums
    console.log('\n🔍 Checking enums...');
    const enums = await prisma.$queryRaw`
      SELECT typname 
      FROM pg_type 
      WHERE typtype = 'e' 
      AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      ORDER BY typname
    `;
    
    const enumNames = enums.map(e => e.typname);
    console.log(`Found ${enumNames.length} enums: ${enumNames.join(', ')}`);
    
    await prisma.$disconnect();
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.message.includes('does not exist')) {
      console.error('\n⚠️  Tables are missing. You need to run the SQL schema first.');
      console.error('   Go to Supabase Dashboard → SQL Editor');
      console.error('   Copy and run the SQL from schema.sql file');
    }
    await prisma.$disconnect();
    process.exit(1);
  }
}

checkTables();

