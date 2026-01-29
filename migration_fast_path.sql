-- ✅ PERFORMANCE: Fast Path Migration SQL
-- Run this in your SQL editor (PostgreSQL/Supabase)

-- 1. Add lockedExposure column to wallets table
ALTER TABLE "wallets" 
ADD COLUMN IF NOT EXISTS "lockedExposure" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 2. Add ACCEPTED and CONFIRMED to BetStatus enum
-- Note: PostgreSQL doesn't support adding enum values directly, so we need to:
-- Option A: If using PostgreSQL, alter the enum type
DO $$ 
BEGIN
    -- Add ACCEPTED if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ACCEPTED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BetStatus')) THEN
        ALTER TYPE "BetStatus" ADD VALUE 'ACCEPTED';
    END IF;
    
    -- Add CONFIRMED if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'CONFIRMED' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BetStatus')) THEN
        ALTER TYPE "BetStatus" ADD VALUE 'CONFIRMED';
    END IF;
END $$;

-- 3. Verify the changes
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'wallets' AND column_name = 'lockedExposure';

SELECT enumlabel 
FROM pg_enum 
WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'BetStatus')
ORDER BY enumsortorder;



