-- AlterTable: Add isRangeConsumed column to bets table
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "isRangeConsumed" BOOLEAN NOT NULL DEFAULT false;

