-- Migration: Create match_visibility table
-- Run this SQL in your Supabase SQL Editor or via Prisma migrate

CREATE TABLE IF NOT EXISTS "match_visibility" (
    "id" SERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_visibility_pkey" PRIMARY KEY ("id")
);

-- Create unique index on eventId
CREATE UNIQUE INDEX IF NOT EXISTS "match_visibility_eventId_key" ON "match_visibility"("eventId");

