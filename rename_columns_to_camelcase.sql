-- ============================================
-- RENAME ALL COLUMNS FROM snake_case TO camelCase
-- This script renames database columns to match the code expectations
-- ============================================

BEGIN;

-- ============================================
-- USERS TABLE
-- ============================================
ALTER TABLE "users" RENAME COLUMN "parent_id" TO "parentId";
ALTER TABLE "users" RENAME COLUMN "commission_percentage" TO "commissionPercentage";
ALTER TABLE "users" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "users" RENAME COLUMN "updated_at" TO "updatedAt";
ALTER TABLE "users" RENAME COLUMN "is_active" TO "isActive";

-- ============================================
-- WALLETS TABLE
-- ============================================
ALTER TABLE "wallets" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "wallets" RENAME COLUMN "locked_exposure" TO "lockedExposure";
ALTER TABLE "wallets" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "wallets" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate foreign key with new column name
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "fk_wallet_user";
ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallet_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================
-- MATCHES TABLE
-- ============================================
ALTER TABLE "matches" RENAME COLUMN "home_team" TO "homeTeam";
ALTER TABLE "matches" RENAME COLUMN "away_team" TO "awayTeam";
ALTER TABLE "matches" RENAME COLUMN "start_time" TO "startTime";
ALTER TABLE "matches" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "matches" RENAME COLUMN "event_name" TO "eventName";
ALTER TABLE "matches" RENAME COLUMN "market_id" TO "marketId";
ALTER TABLE "matches" RENAME COLUMN "market_name" TO "marketName";
ALTER TABLE "matches" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "matches" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_matches_event_id";
DROP INDEX IF EXISTS "idx_matches_status";
CREATE INDEX "idx_matches_event_id" ON "matches"("eventId");
CREATE INDEX "idx_matches_status" ON "matches"("status");

-- ============================================
-- BETS TABLE
-- ============================================
ALTER TABLE "bets" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "bets" RENAME COLUMN "match_id" TO "matchId";
ALTER TABLE "bets" RENAME COLUMN "sel_id" TO "selId";
ALTER TABLE "bets" RENAME COLUMN "selection_id" TO "selectionId";
ALTER TABLE "bets" RENAME COLUMN "bet_type" TO "betType";
ALTER TABLE "bets" RENAME COLUMN "bet_name" TO "betName";
ALTER TABLE "bets" RENAME COLUMN "market_name" TO "marketName";
ALTER TABLE "bets" RENAME COLUMN "market_type" TO "marketType";
ALTER TABLE "bets" RENAME COLUMN "market_id" TO "marketId";
ALTER TABLE "bets" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "bets" RENAME COLUMN "bet_value" TO "betValue";
ALTER TABLE "bets" RENAME COLUMN "bet_rate" TO "betRate";
ALTER TABLE "bets" RENAME COLUMN "win_amount" TO "winAmount";
ALTER TABLE "bets" RENAME COLUMN "loss_amount" TO "lossAmount";
ALTER TABLE "bets" RENAME COLUMN "settlement_id" TO "settlementId";
ALTER TABLE "bets" RENAME COLUMN "to_return" TO "toReturn";
ALTER TABLE "bets" RENAME COLUMN "is_range_consumed" TO "isRangeConsumed";
ALTER TABLE "bets" RENAME COLUMN "settled_at" TO "settledAt";
ALTER TABLE "bets" RENAME COLUMN "rollback_at" TO "rollbackAt";
ALTER TABLE "bets" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "bets" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate foreign keys with new column names
ALTER TABLE "bets" DROP CONSTRAINT IF EXISTS "fk_bet_match";
ALTER TABLE "bets" DROP CONSTRAINT IF EXISTS "fk_bet_user";
ALTER TABLE "bets" ADD CONSTRAINT "fk_bet_match" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "bets" ADD CONSTRAINT "fk_bet_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_bets_created_at";
DROP INDEX IF EXISTS "idx_bets_event_id";
DROP INDEX IF EXISTS "idx_bets_market_id";
DROP INDEX IF EXISTS "idx_bets_settlement_id";
DROP INDEX IF EXISTS "idx_bets_status";
DROP INDEX IF EXISTS "idx_bets_status_event";
DROP INDEX IF EXISTS "idx_bets_status_settlement";
DROP INDEX IF EXISTS "idx_bets_user_id";
DROP INDEX IF EXISTS "idx_bets_user_status";
DROP INDEX IF EXISTS "idx_bets_user_status_created";
CREATE INDEX "idx_bets_created_at" ON "bets"("createdAt");
CREATE INDEX "idx_bets_event_id" ON "bets"("eventId");
CREATE INDEX "idx_bets_market_id" ON "bets"("marketId");
CREATE INDEX "idx_bets_settlement_id" ON "bets"("settlementId");
CREATE INDEX "idx_bets_status" ON "bets"("status");
CREATE INDEX "idx_bets_status_event" ON "bets"("status", "eventId");
CREATE INDEX "idx_bets_status_settlement" ON "bets"("status", "settlementId");
CREATE INDEX "idx_bets_user_id" ON "bets"("userId");
CREATE INDEX "idx_bets_user_status" ON "bets"("userId", "status");
CREATE INDEX "idx_bets_user_status_created" ON "bets"("userId", "status", "createdAt");

-- ============================================
-- TRANSACTIONS TABLE
-- ============================================
ALTER TABLE "transactions" RENAME COLUMN "wallet_id" TO "walletId";
ALTER TABLE "transactions" RENAME COLUMN "created_at" TO "createdAt";

-- Drop and recreate foreign key with new column name
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "fk_transaction_wallet";
ALTER TABLE "transactions" ADD CONSTRAINT "fk_transaction_wallet" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_transactions_type";
DROP INDEX IF EXISTS "idx_transactions_wallet_created";
DROP INDEX IF EXISTS "idx_transactions_wallet_id";
CREATE INDEX "idx_transactions_type" ON "transactions"("type");
CREATE INDEX "idx_transactions_wallet_created" ON "transactions"("walletId", "createdAt");
CREATE INDEX "idx_transactions_wallet_id" ON "transactions"("walletId");

-- ============================================
-- TRANSFER_TRANSACTIONS TABLE
-- ============================================
ALTER TABLE "transfer_transactions" RENAME COLUMN "from_user_id" TO "fromUserId";
ALTER TABLE "transfer_transactions" RENAME COLUMN "to_user_id" TO "toUserId";
ALTER TABLE "transfer_transactions" RENAME COLUMN "commission_percentage" TO "commissionPercentage";
ALTER TABLE "transfer_transactions" RENAME COLUMN "final_amount" TO "finalAmount";
ALTER TABLE "transfer_transactions" RENAME COLUMN "commission_amount" TO "commissionAmount";
ALTER TABLE "transfer_transactions" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "transfer_transactions" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate foreign keys with new column names
ALTER TABLE "transfer_transactions" DROP CONSTRAINT IF EXISTS "fk_transfer_from";
ALTER TABLE "transfer_transactions" DROP CONSTRAINT IF EXISTS "fk_transfer_to";
ALTER TABLE "transfer_transactions" ADD CONSTRAINT "fk_transfer_from" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "transfer_transactions" ADD CONSTRAINT "fk_transfer_to" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================
-- TRANSFER_LOGS TABLE
-- ============================================
ALTER TABLE "transfer_logs" RENAME COLUMN "from_user_id" TO "fromUserId";
ALTER TABLE "transfer_logs" RENAME COLUMN "to_user_id" TO "toUserId";
ALTER TABLE "transfer_logs" RENAME COLUMN "created_at" TO "createdAt";

-- ============================================
-- SETTLEMENTS TABLE
-- ============================================
ALTER TABLE "settlements" RENAME COLUMN "settlement_id" TO "settlementId";
ALTER TABLE "settlements" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "settlements" RENAME COLUMN "market_type" TO "marketType";
ALTER TABLE "settlements" RENAME COLUMN "market_id" TO "marketId";
ALTER TABLE "settlements" RENAME COLUMN "winner_id" TO "winnerId";
ALTER TABLE "settlements" RENAME COLUMN "settled_by" TO "settledBy";
ALTER TABLE "settlements" RENAME COLUMN "is_rollback" TO "isRollback";
ALTER TABLE "settlements" RENAME COLUMN "created_at" TO "createdAt";

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_settlements_created_at";
DROP INDEX IF EXISTS "idx_settlements_event_id";
DROP INDEX IF EXISTS "idx_settlements_event_market";
DROP INDEX IF EXISTS "idx_settlements_is_rollback";
DROP INDEX IF EXISTS "idx_settlements_market_type";
CREATE INDEX "idx_settlements_created_at" ON "settlements"("createdAt");
CREATE INDEX "idx_settlements_event_id" ON "settlements"("eventId");
CREATE INDEX "idx_settlements_event_market" ON "settlements"("eventId", "marketType");
CREATE INDEX "idx_settlements_is_rollback" ON "settlements"("isRollback");
CREATE INDEX "idx_settlements_market_type" ON "settlements"("marketType");

-- ============================================
-- USER_PNL TABLE
-- ============================================
ALTER TABLE "user_pnl" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "user_pnl" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "user_pnl" RENAME COLUMN "market_type" TO "marketType";
ALTER TABLE "user_pnl" RENAME COLUMN "net_pnl" TO "netPnl";
ALTER TABLE "user_pnl" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "user_pnl" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate unique constraint with new column names
ALTER TABLE "user_pnl" DROP CONSTRAINT IF EXISTS "uq_user_pnl";
ALTER TABLE "user_pnl" ADD CONSTRAINT "uq_user_pnl" UNIQUE ("userId", "eventId", "marketType");

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_user_pnl_event_id";
DROP INDEX IF EXISTS "idx_user_pnl_user_event";
DROP INDEX IF EXISTS "idx_user_pnl_user_id";
CREATE INDEX "idx_user_pnl_event_id" ON "user_pnl"("eventId");
CREATE INDEX "idx_user_pnl_user_event" ON "user_pnl"("userId", "eventId");
CREATE INDEX "idx_user_pnl_user_id" ON "user_pnl"("userId");

-- ============================================
-- HIERARCHY_PNL TABLE
-- ============================================
ALTER TABLE "hierarchy_pnl" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "hierarchy_pnl" RENAME COLUMN "market_type" TO "marketType";
ALTER TABLE "hierarchy_pnl" RENAME COLUMN "from_user_id" TO "fromUserId";
ALTER TABLE "hierarchy_pnl" RENAME COLUMN "to_user_id" TO "toUserId";
ALTER TABLE "hierarchy_pnl" RENAME COLUMN "created_at" TO "createdAt";

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_hierarchy_pnl_event_market_from";
DROP INDEX IF EXISTS "idx_hierarchy_pnl_from";
DROP INDEX IF EXISTS "idx_hierarchy_pnl_to";
CREATE INDEX "idx_hierarchy_pnl_event_market_from" ON "hierarchy_pnl"("eventId", "marketType", "fromUserId");
CREATE INDEX "idx_hierarchy_pnl_from" ON "hierarchy_pnl"("fromUserId");
CREATE INDEX "idx_hierarchy_pnl_to" ON "hierarchy_pnl"("toUserId");

-- ============================================
-- POSITIONS TABLE
-- ============================================
ALTER TABLE "positions" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "positions" RENAME COLUMN "match_id" TO "matchId";
ALTER TABLE "positions" RENAME COLUMN "market_type" TO "marketType";
ALTER TABLE "positions" RENAME COLUMN "selection_id" TO "selectionId";
ALTER TABLE "positions" RENAME COLUMN "runner_name" TO "runnerName";
ALTER TABLE "positions" RENAME COLUMN "back_stake" TO "backStake";
ALTER TABLE "positions" RENAME COLUMN "back_odds" TO "backOdds";
ALTER TABLE "positions" RENAME COLUMN "lay_stake" TO "layStake";
ALTER TABLE "positions" RENAME COLUMN "lay_odds" TO "layOdds";
ALTER TABLE "positions" RENAME COLUMN "pnl_if_win" TO "pnlIfWin";
ALTER TABLE "positions" RENAME COLUMN "pnl_if_lose" TO "pnlIfLose";
ALTER TABLE "positions" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "positions" RENAME COLUMN "updated_at" TO "updatedAt";

-- Drop and recreate foreign key with new column name
ALTER TABLE "positions" DROP CONSTRAINT IF EXISTS "fk_position_user";
ALTER TABLE "positions" ADD CONSTRAINT "fk_position_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Drop and recreate unique constraint with new column names
ALTER TABLE "positions" DROP CONSTRAINT IF EXISTS "uq_position";
ALTER TABLE "positions" ADD CONSTRAINT "uq_position" UNIQUE ("userId", "matchId", "marketType", "selectionId");

-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_positions_match_market_sel";
DROP INDEX IF EXISTS "idx_positions_user";
DROP INDEX IF EXISTS "idx_positions_user_match";
CREATE INDEX "idx_positions_match_market_sel" ON "positions"("matchId", "marketType", "selectionId");
CREATE INDEX "idx_positions_user" ON "positions"("userId");
CREATE INDEX "idx_positions_user_match" ON "positions"("userId", "matchId");

-- ============================================
-- MATCH_VISIBILITY TABLE
-- ============================================
ALTER TABLE "match_visibility" RENAME COLUMN "event_id" TO "eventId";
ALTER TABLE "match_visibility" RENAME COLUMN "is_enabled" TO "isEnabled";
ALTER TABLE "match_visibility" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "match_visibility" RENAME COLUMN "updated_at" TO "updatedAt";

-- ============================================
-- SITE_VIDEOS TABLE
-- ============================================
-- Note: This table already uses camelCase in Prisma schema with @map directives
-- But if the database columns are snake_case, we need to rename them
ALTER TABLE "site_videos" RENAME COLUMN "video_url" TO "videoUrl";
ALTER TABLE "site_videos" RENAME COLUMN "is_active" TO "isActive";
ALTER TABLE "site_videos" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "site_videos" RENAME COLUMN "updated_at" TO "updatedAt";

-- ============================================
-- USERS TABLE INDEXES
-- ============================================
-- Drop and recreate indexes with new column names
DROP INDEX IF EXISTS "idx_users_parent_id";
DROP INDEX IF EXISTS "idx_users_parent_role";
DROP INDEX IF EXISTS "idx_users_role";
CREATE INDEX "idx_users_parent_id" ON "users"("parentId");
CREATE INDEX "idx_users_parent_role" ON "users"("parentId", "role");
CREATE INDEX "idx_users_role" ON "users"("role");

-- Drop and recreate foreign key with new column name
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "fk_parent";
ALTER TABLE "users" ADD CONSTRAINT "fk_parent" FOREIGN KEY ("parentId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;

-- ============================================
-- VERIFICATION QUERIES (run these to verify)
-- ============================================
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'bets' ORDER BY ordinal_position;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'matches' ORDER BY ordinal_position;







