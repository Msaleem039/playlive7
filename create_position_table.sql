-- Create Position table for tracking BACK/LAY positions and P/L
-- This table enables proper netting of BACK vs LAY bets

CREATE TABLE IF NOT EXISTS "positions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "marketType" TEXT NOT NULL,
  "selectionId" INTEGER NOT NULL,
  "runnerName" TEXT,
  
  "backStake" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "backOdds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "layStake" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "layOdds" DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  "pnlIfWin" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pnlIfLose" DOUBLE PRECISION NOT NULL DEFAULT 0,
  
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") 
    REFERENCES "users"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE
);

-- Create unique constraint: one position per user/match/market/selection
CREATE UNIQUE INDEX IF NOT EXISTS "positions_userId_matchId_marketType_selectionId_key" 
  ON "positions"("userId", "matchId", "marketType", "selectionId");

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS "positions_userId_idx" 
  ON "positions"("userId");

CREATE INDEX IF NOT EXISTS "positions_userId_matchId_idx" 
  ON "positions"("userId", "matchId");

CREATE INDEX IF NOT EXISTS "positions_matchId_marketType_selectionId_idx" 
  ON "positions"("matchId", "marketType", "selectionId");

-- Create trigger function to auto-update updatedAt timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updatedAt on row update
-- Note: If trigger already exists, you may need to drop it first manually
-- DROP TRIGGER IF EXISTS update_positions_updated_at ON "positions";
CREATE TRIGGER update_positions_updated_at
  BEFORE UPDATE ON "positions"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

