#!/bin/bash

# Script to verify production .env file
# Run this on your production server: bash scripts/verify-production-env.sh

echo "🔍 Verifying Production .env File..."
echo ""

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ .env file not found!"
    echo "💡 Create it with: cp env.production.example .env"
    exit 1
fi

echo "✅ .env file exists"
echo ""

# Check required variables
MISSING_VARS=()

if ! grep -q "^NODE_ENV=" "$ENV_FILE"; then
    MISSING_VARS+=("NODE_ENV")
fi

if ! grep -q "^JWT_SECRET=" "$ENV_FILE"; then
    MISSING_VARS+=("JWT_SECRET")
fi

if ! grep -q "^DATABASE_URL=" "$ENV_FILE"; then
    MISSING_VARS+=("DATABASE_URL")
fi

# Check optional but recommended
if ! grep -q "^DIRECT_URL=" "$ENV_FILE"; then
    echo "⚠️  DIRECT_URL not set (optional but recommended for migrations)"
fi

if ! grep -q "^PORT=" "$ENV_FILE"; then
    echo "⚠️  PORT not set (will default to 3000)"
fi

# Display results
if [ ${#MISSING_VARS[@]} -eq 0 ]; then
    echo "✅ All required variables are set!"
    echo ""
    echo "📋 Current Configuration:"
    echo "   NODE_ENV: $(grep "^NODE_ENV=" "$ENV_FILE" | cut -d'=' -f2)"
    echo "   PORT: $(grep "^PORT=" "$ENV_FILE" | cut -d'=' -f2 || echo '3000 (default)')"
    echo "   JWT_SECRET: $(grep "^JWT_SECRET=" "$ENV_FILE" | cut -d'=' -f2 | sed 's/./*/g' | head -c 20)..."
    echo "   DATABASE_URL: $(grep "^DATABASE_URL=" "$ENV_FILE" | cut -d'=' -f2 | sed 's/:[^:@]*@/:****@/')"
    echo ""
    echo "🎉 Your .env file is properly configured!"
else
    echo "❌ Missing required variables:"
    for var in "${MISSING_VARS[@]}"; do
        echo "   - $var"
    done
    echo ""
    echo "💡 Add these to your .env file:"
    echo ""
    for var in "${MISSING_VARS[@]}"; do
        case $var in
            NODE_ENV)
                echo "NODE_ENV=production"
                ;;
            JWT_SECRET)
                echo "JWT_SECRET=your-super-secret-jwt-key-change-this-in-production"
                echo "# Generate a strong secret with: openssl rand -base64 32"
                ;;
            DATABASE_URL)
                echo 'DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"'
                ;;
        esac
    done
    exit 1
fi

