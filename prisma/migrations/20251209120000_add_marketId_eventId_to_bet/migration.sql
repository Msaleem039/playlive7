-- AlterTable: Add marketId and eventId columns to bets table
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "marketId" TEXT;
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "eventId" TEXT;

