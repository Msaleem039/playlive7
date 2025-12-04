#!/usr/bin/env node

/**
 * Quick script to create .env file for local development with Neon database
 */

const fs = require('fs');
const path = require('path');

const envContent = `# Local Development Environment
# This file is for local development only
# For production, use the server's .env file

NODE_ENV=development
PORT=3000

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Neon Database Configuration
DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
DIRECT_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
`;

const envPath = path.join(process.cwd(), '.env');

try {
  // Check if .env already exists
  if (fs.existsSync(envPath)) {
    console.log('⚠️  .env file already exists!');
    console.log('📁 Location:', envPath);
    console.log('\nTo update it, edit the file manually or delete it first.');
    process.exit(0);
  }

  // Create .env file
  fs.writeFileSync(envPath, envContent);
  
  console.log('✅ .env file created successfully!');
  console.log('📁 Location:', envPath);
  console.log('\n📝 Contents:');
  console.log('   - NODE_ENV=development');
  console.log('   - DATABASE_URL (Neon PostgreSQL)');
  console.log('   - JWT_SECRET');
  console.log('\n⚠️  Important: Keep your .env file secure and never commit it to git!');
  console.log('\n🔄 Next steps:');
  console.log('   1. Restart your application');
  console.log('   2. The app should now connect to Neon database');
  console.log('   3. Run: npm run verify:db (to verify connection)');
} catch (error) {
  console.error('❌ Error creating .env file:', error.message);
  process.exit(1);
}

