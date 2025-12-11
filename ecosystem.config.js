// Load environment variables from .env file
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// Verify critical environment variables are loaded
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  WARNING: DATABASE_URL not found in environment!');
  console.warn('   Make sure .env file exists in:', __dirname);
}

module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      // Use env_file for PM2 5.0+ (fallback to env if not supported)
      env_file: path.resolve(__dirname, '.env'),
      // Explicitly pass environment variables to ensure they're loaded
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PORT || 3000,
        DATABASE_URL: process.env.DATABASE_URL,
        DIRECT_URL: process.env.DIRECT_URL,
        JWT_SECRET: process.env.JWT_SECRET,
        CORS_ORIGINS: process.env.CORS_ORIGINS || '*',
        // Pass through any other environment variables
        ...process.env,
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
  ],
};

