const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const prisma = new PrismaClient();

async function createTables() {
  try {
    console.log('🔧 Creating database tables from Prisma schema...\n');
    
    // Read the generated SQL schema
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.error('❌ schema.sql file not found!');
      console.log('   Generating SQL schema...');
      // Generate SQL schema
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      try {
        await execAsync('npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > schema.sql', {
          cwd: path.join(__dirname, '..'),
        });
        console.log('   ✅ SQL schema generated');
      } catch (error) {
        console.error('   ❌ Failed to generate SQL schema:', error.message);
        process.exit(1);
      }
    }
    
    const sql = fs.readFileSync(schemaPath, 'utf8');
    
    // Split SQL into individual statements
    // Remove comments and split by semicolons
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))
      .filter(s => !s.match(/^\s*$/));
    
    console.log(`📋 Found ${statements.length} SQL statements to execute\n`);
    
    // Execute each statement
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      
      // Skip empty statements
      if (!statement || statement.trim().length === 0) continue;
      
      try {
        // Execute the statement
        await prisma.$executeRawUnsafe(statement);
        successCount++;
        
        // Log progress for important statements
        if (statement.includes('CREATE TYPE') || statement.includes('CREATE TABLE')) {
          const match = statement.match(/CREATE (TYPE|TABLE)\s+"?(\w+)"?/i);
          if (match) {
            console.log(`   ✅ Created ${match[1]}: ${match[2]}`);
          }
        }
      } catch (error) {
        // Ignore "already exists" errors
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate') ||
            error.code === '42P07' || // duplicate_table
            error.code === '42710') { // duplicate_object
          console.log(`   ⚠️  Already exists: ${statement.substring(0, 50)}...`);
          successCount++;
        } else {
          errorCount++;
          console.error(`   ❌ Error executing statement ${i + 1}:`, error.message);
          console.error(`   Statement: ${statement.substring(0, 100)}...`);
        }
      }
    }
    
    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Successful: ${successCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    
    if (errorCount === 0) {
      console.log('\n✅ All tables created successfully!');
    } else {
      console.log('\n⚠️  Some errors occurred, but tables may still be created.');
    }
    
    // Verify tables were created
    console.log('\n🔍 Verifying tables...');
    const tables = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    
    console.log(`\n📋 Created tables (${tables.length}):`);
    tables.forEach(table => {
      console.log(`   • ${table.table_name}`);
    });
    
    await prisma.$disconnect();
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    await prisma.$disconnect();
    process.exit(1);
  }
}

createTables();

