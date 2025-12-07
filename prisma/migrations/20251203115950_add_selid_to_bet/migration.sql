-- AlterTable: Add selId column to bets table
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "selId" INTEGER;
