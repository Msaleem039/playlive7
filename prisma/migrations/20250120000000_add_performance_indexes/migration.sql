-- Add performance indexes for frequently queried columns
-- This migration significantly improves query performance for:
-- - Bet lookups by userId, status, eventId, marketId, settlementId
-- - User hierarchy queries
-- - Settlement queries
-- - PnL calculations

-- Indexes for bets table (most queried table)
CREATE INDEX IF NOT EXISTS "bets_userId_idx" ON "bets"("userId");
CREATE INDEX IF NOT EXISTS "bets_userId_status_idx" ON "bets"("userId", "status");
CREATE INDEX IF NOT EXISTS "bets_eventId_idx" ON "bets"("eventId");
CREATE INDEX IF NOT EXISTS "bets_marketId_idx" ON "bets"("marketId");
CREATE INDEX IF NOT EXISTS "bets_settlementId_idx" ON "bets"("settlementId");
CREATE INDEX IF NOT EXISTS "bets_status_idx" ON "bets"("status");
CREATE INDEX IF NOT EXISTS "bets_status_eventId_idx" ON "bets"("status", "eventId");
CREATE INDEX IF NOT EXISTS "bets_status_settlementId_idx" ON "bets"("status", "settlementId");
CREATE INDEX IF NOT EXISTS "bets_createdAt_idx" ON "bets"("createdAt");
CREATE INDEX IF NOT EXISTS "bets_userId_status_createdAt_idx" ON "bets"("userId", "status", "createdAt");

-- Indexes for users table
CREATE INDEX IF NOT EXISTS "users_parentId_idx" ON "users"("parentId");
CREATE INDEX IF NOT EXISTS "users_role_idx" ON "users"("role");
CREATE INDEX IF NOT EXISTS "users_parentId_role_idx" ON "users"("parentId", "role");

-- Indexes for matches table
CREATE INDEX IF NOT EXISTS "matches_eventId_idx" ON "matches"("eventId");
CREATE INDEX IF NOT EXISTS "matches_status_idx" ON "matches"("status");

-- Indexes for settlements table
CREATE INDEX IF NOT EXISTS "settlements_eventId_idx" ON "settlements"("eventId");
CREATE INDEX IF NOT EXISTS "settlements_marketType_idx" ON "settlements"("marketType");
CREATE INDEX IF NOT EXISTS "settlements_isRollback_idx" ON "settlements"("isRollback");
CREATE INDEX IF NOT EXISTS "settlements_createdAt_idx" ON "settlements"("createdAt");
CREATE INDEX IF NOT EXISTS "settlements_eventId_marketType_idx" ON "settlements"("eventId", "marketType");

-- Indexes for user_pnl table
CREATE INDEX IF NOT EXISTS "user_pnl_userId_idx" ON "user_pnl"("userId");
CREATE INDEX IF NOT EXISTS "user_pnl_eventId_idx" ON "user_pnl"("eventId");
CREATE INDEX IF NOT EXISTS "user_pnl_userId_eventId_idx" ON "user_pnl"("userId", "eventId");

-- Indexes for hierarchy_pnl table
CREATE INDEX IF NOT EXISTS "hierarchy_pnl_eventId_marketType_fromUserId_idx" ON "hierarchy_pnl"("eventId", "marketType", "fromUserId");
CREATE INDEX IF NOT EXISTS "hierarchy_pnl_toUserId_idx" ON "hierarchy_pnl"("toUserId");
CREATE INDEX IF NOT EXISTS "hierarchy_pnl_fromUserId_idx" ON "hierarchy_pnl"("fromUserId");

-- Indexes for transactions table
CREATE INDEX IF NOT EXISTS "transactions_walletId_idx" ON "transactions"("walletId");
CREATE INDEX IF NOT EXISTS "transactions_walletId_createdAt_idx" ON "transactions"("walletId", "createdAt");
CREATE INDEX IF NOT EXISTS "transactions_type_idx" ON "transactions"("type");

