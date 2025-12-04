#!/usr/bin/env node

/**
 * Environment Setup Helper Script
 * 
 * This script helps you create a .env file for production.
 * It will prompt you for database credentials and create the .env file.
 * 
 * Usage:
 *   node scripts/setup-env.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setupEnv() {
  console.log('🔧 Production Environment Setup\n');
  console.log('This script will help you create a .env file for production.\n');
  console.log('You can find your database credentials in:');
  console.log('  - Your hosting provider dashboard (Hostinger, etc.)');
  console.log('  - Your database provider dashboard (Neon, Supabase, etc.)');
  console.log('  - Your server configuration files\n');

  const nodeEnv = await question('NODE_ENV (default: production): ') || 'production';
  const port = await question('PORT (default: 3000): ') || '3000';
  const jwtSecret = await question('JWT_SECRET (enter a strong random string): ') || 'change-this-to-a-strong-random-secret';
  
  console.log('\n📊 Database Configuration:');
  console.log('Enter your database connection details:\n');
  
  const dbHost = await question('Database Host (e.g., your-db.neon.tech or localhost): ');
  const dbPort = await question('Database Port (default: 5432): ') || '5432';
  const dbUsername = await question('Database Username: ');
  const dbPassword = await question('Database Password: ');
  const dbName = await question('Database Name: ');
  
  // Construct DATABASE_URL
  const databaseUrl = `postgresql://${dbUsername}:${dbPassword}@${dbHost}:${dbPort}/${dbName}?sslmode=require`;
  
  // Create .env content
  const envContent = `# Production Database Configuration
NODE_ENV=${nodeEnv}
PORT=${port}

# JWT Configuration
JWT_SECRET=${jwtSecret}

# Database Configuration
DATABASE_URL="${databaseUrl}"
DIRECT_URL="${databaseUrl}"
`;

  // Write .env file
  const envPath = path.join(process.cwd(), '.env');
  
  console.log('\n📝 Creating .env file...');
  fs.writeFileSync(envPath, envContent);
  
  console.log('✅ .env file created successfully!');
  console.log(`📁 Location: ${envPath}\n`);
  console.log('⚠️  Important: Keep your .env file secure and never commit it to git!\n');
  
  rl.close();
}

setupEnv().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});

