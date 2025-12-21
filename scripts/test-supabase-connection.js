const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

console.log('🔍 Testing Supabase Connection...\n');

// Check environment variables
const dbUrl = process.env.DATABASE_URL;
const directUrl = process.env.DIRECT_URL;

if (!dbUrl) {
  console.error('❌ DATABASE_URL is not set in .env file');
  process.exit(1);
}

console.log('📋 Configuration:');
console.log('   DATABASE_URL:', dbUrl.replace(/:[^:@]+@/, ':****@'));
console.log('   DIRECT_URL:', directUrl ? directUrl.replace(/:[^:@]+@/, ':****@') : 'Not set');

// Extract connection details
try {
  const url = new URL(dbUrl);
  console.log('\n🔗 Connection Details:');
  console.log('   Host:', url.hostname);
  console.log('   Port:', url.port || '5432');
  console.log('   Database:', url.pathname.replace('/', ''));
  console.log('   User:', url.username);
  console.log('   SSL Mode:', url.searchParams.get('sslmode') || 'not set');
  
  // Check if it's Supabase
  if (url.hostname.includes('supabase.co')) {
    console.log('   ✅ Supabase connection detected');
  }
} catch (error) {
  console.error('❌ Invalid connection string format:', error.message);
  process.exit(1);
}

// Test connection
console.log('\n🔌 Testing database connection...');
const prisma = new PrismaClient();

async function testConnection() {
  try {
    console.log('   Attempting to connect...');
    
    // Set timeout
    const connectionPromise = prisma.$connect();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout after 15 seconds')), 15000)
    );

    await Promise.race([connectionPromise, timeoutPromise]);
    
    console.log('   ✅ Connection successful!');
    
    // Test a simple query
    console.log('   Testing query...');
    const result = await prisma.$queryRaw`SELECT version() as version`;
    console.log('   ✅ Query test successful!');
    console.log('   Database version:', result[0]?.version?.substring(0, 50) || 'Unknown');
    
    await prisma.$disconnect();
    console.log('\n✅ All tests passed! Supabase connection is working.');
    return true;
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('   Error:', error.message);
    console.error('   Error Code:', error.code || 'N/A');
    
    if (error.code === 'P1001') {
      console.error('\n🌐 Network Connection Issue (P1001):');
      console.error('   This means the database server cannot be reached.');
      console.error('\n   Possible causes:');
      console.error('   1. VPN/Network blocking the connection');
      console.error('   2. Supabase project is paused or inactive');
      console.error('   3. IP restrictions in Supabase (check Dashboard → Settings → Database)');
      console.error('   4. Firewall blocking port 5432');
      console.error('   5. DNS resolution issues');
      console.error('\n   Solutions:');
      console.error('   • Try disabling VPN temporarily');
      console.error('   • Check Supabase Dashboard → ensure project is active');
      console.error('   • Verify IP restrictions in Supabase Settings');
      console.error('   • Check firewall settings');
      console.error('   • Try using a different network');
    } else if (error.code === 'P1000') {
      console.error('\n🔑 Authentication Error (P1000):');
      console.error('   Username or password is incorrect.');
      console.error('   • Check password in .env file');
      console.error('   • Verify password is URL-encoded (special chars like : become %3A)');
      console.error('   • Get correct password from Supabase Dashboard → Settings → Database');
    } else if (error.code === 'P1003') {
      console.error('\n📦 Database Not Found (P1003):');
      console.error('   The database name is incorrect.');
      console.error('   • Default Supabase database name is "postgres"');
      console.error('   • Verify database name in connection string');
    }
    
    await prisma.$disconnect().catch(() => {});
    return false;
  }
}

testConnection()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });

