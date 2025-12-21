const fs = require('fs');
const path = require('path');

// Supabase Transaction Pooler connection details (from your screenshot)
const supabaseConfig = {
  user: 'postgres.isdzyrpqrpmprnxanzdg', // Pooler username includes project ID
  password: 'playlive7@786', // Password with @ symbol (needs URL encoding)
  host: 'aws-1-eu-west-1.pooler.supabase.com', // Pooler hostname (different from direct)
  port: '6543', // Transaction Pooler port
  database: 'postgres',
};

// URL encode the password (@ becomes %40)
const encodedPassword = encodeURIComponent(supabaseConfig.password);

// Build connection string
const connectionString = `postgresql://${supabaseConfig.user}:${encodedPassword}@${supabaseConfig.host}:${supabaseConfig.port}/${supabaseConfig.database}?sslmode=require`;

console.log('🔧 Updating .env file with Supabase Transaction Pooler connection...\n');
console.log('Connection string:', connectionString.replace(/:[^:@]+@/, ':****@'));
console.log('Password encoding: playlive7@786 → playlive7%40786 (@ becomes %40)');

// Read current .env file
const envPath = path.join(__dirname, '..', '.env');
let envContent = '';

if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, 'utf8');
} else {
  console.error('❌ .env file not found!');
  process.exit(1);
}

// Update DATABASE_URL
envContent = envContent.replace(
  /^DATABASE_URL=.*$/m,
  `DATABASE_URL="${connectionString}"`
);

// Update DIRECT_URL (use same pooler connection for Supabase)
envContent = envContent.replace(
  /^DIRECT_URL=.*$/m,
  `DIRECT_URL="${connectionString}"`
);

// Update database configuration comments
const supabaseComment = `# Database Configuration - Supabase PostgreSQL Transaction Pooler
# Using Transaction Pooler (IPv4 compatible, works with VPN)
# 
# IMPORTANT: This is the pooler connection, not direct connection
# - Host: aws-1-eu-west-1.pooler.supabase.com (pooler endpoint)
# - Port: 6543 (Transaction Pooler)
# - Username: postgres.isdzyrpqrpmprnxanzdg (includes project ID)
# - Password: playlive7@786 (URL encoded as playlive7%40786)
#
# Note: Transaction Pooler does not support PREPARE statements
# For Supabase, DATABASE_URL and DIRECT_URL use the same pooler connection:`;

envContent = envContent.replace(
  /# Database Configuration[\s\S]*?DIRECT_URL=.*$/m,
  `${supabaseComment}\nDATABASE_URL="${connectionString}"\nDIRECT_URL="${connectionString}"`
);

// Write updated content
fs.writeFileSync(envPath, envContent, 'utf8');

console.log('\n✅ .env file updated successfully!');
console.log('\n📋 Changes made:');
console.log('   • Host: aws-1-eu-west-1.pooler.supabase.com (Transaction Pooler)');
console.log('   • Port: 6543 (Transaction Pooler)');
console.log('   • Username: postgres.isdzyrpqrpmprnxanzdg (with project ID)');
console.log('   • Password: playlive7@786 (URL encoded)');
console.log('   • IPv4 compatible ✅');
console.log('\n🔄 Next steps:');
console.log('   1. Test connection: node scripts/test-supabase-connection.js');
console.log('   2. Regenerate Prisma: npx prisma generate');
console.log('   3. Push schema: npx prisma db push');

