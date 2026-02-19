-- Fix isRangeConsumed column name to match Prisma schema mapping
-- This will rename isRangeConsumed to is_range_consumed if it exists

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'bets' AND column_name = 'isRangeConsumed'
    ) THEN
        ALTER TABLE "bets" RENAME COLUMN "isRangeConsumed" TO "is_range_consumed";
    END IF;
END $$;
