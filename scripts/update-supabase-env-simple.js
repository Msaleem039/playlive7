const fs = require('fs');
const path = require('path');

// Your actual Supabase connection details
const supabaseConfig = {
  user: 'postgres',
  password: 'plalive7', // Your actual password (no special characters, so no URL encoding needed)
  host: 'db.isdzyrpqrpmprnxanzdg.supabase.co',
  port: '6543', // Session Pooler port (IPv4 compatible) - NOT 5432
  database: 'postgres',
};

// Build connection string (no URL encoding needed since password has no special chars)
const connectionString = `postgresql://${supabaseConfig.user}:${supabaseConfig.password}@${supabaseConfig.host}:${supabaseConfig.port}/${supabaseConfig.database}?sslmode=require`;

console.log('🔧 Updating .env file with Supabase Session Pooler connection...\n');
console.log('Connection string:', connectionString.replace(/:[^:@]+@/, ':****@'));

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

// Update DIRECT_URL (use same connection string for Supabase)
envContent = envContent.replace(
  /^DIRECT_URL=.*$/m,
  `DIRECT_URL="${connectionString}"`
);

// Write updated content
fs.writeFileSync(envPath, envContent, 'utf8');

console.log('✅ .env file updated successfully!');
console.log('\n📋 Changes made:');
console.log('   • Changed port from 5432 → 6543 (Session Pooler, IPv4 compatible)');
console.log('   • Password: plalive7 (no URL encoding needed - no special characters)');
console.log('\n💡 Why port 6543?');
console.log('   • Port 5432 = Direct connection (IPv6 only, won\'t work with VPN)');
console.log('   • Port 6543 = Session Pooler (IPv4 compatible, works with VPN)');
console.log('\n🔄 Next steps:');
console.log('   1. Restart your application');
console.log('   2. Test connection: node scripts/test-supabase-connection.js');

