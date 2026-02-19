-- AlterTable: Add is_range_consumed column to bets table (matches Prisma @map directive)
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "is_range_consumed" BOOLEAN NOT NULL DEFAULT false;

