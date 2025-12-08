#!/bin/bash

# Script to fix .env file on production
# This ensures DATABASE_URL and DIRECT_URL are correctly set

ENV_FILE="/var/www/backend/.env"
BACKUP_FILE="/var/www/backend/.env.backup.$(date +%s)"

echo "🔧 Fixing .env file..."

# Backup
cp "$ENV_FILE" "$BACKUP_FILE"
echo "💾 Backup created: $BACKUP_FILE"

# Remove any existing DATABASE_URL or DIRECT_URL lines (including commented ones)
sed -i '/^[[:space:]]*DATABASE_URL=/d' "$ENV_FILE"
sed -i '/^[[:space:]]*DIRECT_URL=/d' "$ENV_FILE"
sed -i '/^[[:space:]]*#.*DATABASE_URL/d' "$ENV_FILE"
sed -i '/^[[:space:]]*#.*DIRECT_URL/d' "$ENV_FILE"

# Add correct DATABASE_URL and DIRECT_URL at the end
cat >> "$ENV_FILE" << 'EOF'

# Database URLs (added by fix script)
DATABASE_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
DIRECT_URL="postgresql://neondb_owner:npg_WmMlE87jswPb@ep-cool-river-adw2zvak.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
EOF

echo "✅ .env file fixed!"
echo ""
echo "Verifying..."
grep -E "^(DATABASE_URL|DIRECT_URL)=" "$ENV_FILE"

