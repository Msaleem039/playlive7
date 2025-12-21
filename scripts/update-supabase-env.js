const fs = require('fs');
const path = require('path');

// Supabase connection details
const supabaseConfig = {
  user: 'postgres',
  password: 'plalive7host:', // Password with colon
  host: 'db.isdzyrpqrpmprnxanzdg.supabase.co',
  // IMPORTANT: Direct connection (port 5432) is IPv6-only and may not work with VPNs
  // Use Session Pooler (port 6543) for IPv4 compatibility
  // Transaction Pooler (port 6543) is also available but Session Pooler is recommended
  port: '6543', // Session Pooler port (IPv4 compatible) - use this instead of 5432
  database: 'postgres',
  // Connection modes:
  // - Port 5432: Direct connection (IPv6 only, not compatible with IPv4 networks/VPNs)
  // - Port 6543: Session Pooler (IPv4 compatible, recommended for VPNs)
  // - Port 6543: Transaction Pooler (IPv4 compatible, for serverless)
};

// URL encode the password (colon becomes %3A)
const encodedPassword = encodeURIComponent(supabaseConfig.password);

// Build connection string
const connectionString = `postgresql://${supabaseConfig.user}:${encodedPassword}@${supabaseConfig.host}:${supabaseConfig.port}/${supabaseConfig.database}?sslmode=require`;

console.log('🔧 Updating .env file with Supabase configuration...\n');
console.log('Connection string:', connectionString.replace(/:[^:@]+@/, ':****@')); // Hide password in output

// Read current .env file
const envPath = path.join(__dirname, '..', '.env');
let envContent = '';

if (fs.existsSync(envPath)) {
  envContent = fs.readFileSync(envPath, 'utf8');
} else {
  console.log('⚠️  .env file not found, creating new one from template...');
  const templatePath = path.join(__dirname, '..', 'env.production.example');
  if (fs.existsSync(templatePath)) {
    envContent = fs.readFileSync(templatePath, 'utf8');
  }
}

// Update DATABASE_URL
envContent = envContent.replace(
  /^DATABASE_URL=.*$/m,
  `DATABASE_URL="${connectionString}"`
);

// Update DIRECT_URL (Supabase uses same connection string)
envContent = envContent.replace(
  /^DIRECT_URL=.*$/m,
  `DIRECT_URL="${connectionString}"`
);

// Update database configuration comments
const supabaseComment = `# Database Configuration - Supabase PostgreSQL
# Supabase doesn't use separate pooler/direct URLs, so both use the same connection string
# Connection Pooling: Supabase handles connection pooling automatically
# 
# Supabase Database Details:
# Host: ${supabaseConfig.host}
# Port: ${supabaseConfig.port}
# Database: ${supabaseConfig.database}
# User: ${supabaseConfig.user}
#
# For Supabase, DATABASE_URL and DIRECT_URL can be the same:`;

envContent = envContent.replace(
  /# Database Configuration[\s\S]*?DIRECT_URL=.*$/m,
  `${supabaseComment}\nDATABASE_URL="${connectionString}"\nDIRECT_URL="${connectionString}"`
);

// Write updated content
fs.writeFileSync(envPath, envContent, 'utf8');

console.log('✅ .env file updated successfully!');
console.log('\n📋 Updated configuration:');
console.log('   DATABASE_URL: Supabase connection string');
console.log('   DIRECT_URL: Supabase connection string (same as DATABASE_URL)');
console.log('\n💡 Next steps:');
console.log('   1. Restart your application');
console.log('   2. Run: npm run verify:env to test the connection');
console.log('   3. Run: npx prisma generate to regenerate Prisma client');
console.log('   4. Run: npx prisma db push to sync your schema');

