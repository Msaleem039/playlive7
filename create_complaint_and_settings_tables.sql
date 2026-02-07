-- ============================================
-- CREATE SETTINGS TABLE (for News Bar)
-- ============================================
CREATE TABLE IF NOT EXISTS "settings" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- Create unique index on key
CREATE UNIQUE INDEX IF NOT EXISTS "settings_key_key" ON "settings"("key");

-- ============================================
-- CREATE COMPLAINTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS "complaints" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::TEXT,
  "name" TEXT NOT NULL,
  "contact_number" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS "idx_complaints_status" ON "complaints"("status");

-- Create index on created_at for sorting
CREATE INDEX IF NOT EXISTS "idx_complaints_created_at" ON "complaints"("created_at" DESC);

