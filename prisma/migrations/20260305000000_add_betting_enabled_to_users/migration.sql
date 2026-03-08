-- Add betting_enabled to users (disable betting for downline when agent is stopped)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "betting_enabled" BOOLEAN NOT NULL DEFAULT true;
