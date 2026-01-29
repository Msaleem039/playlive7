-- ============================================
-- DROP ALL EXISTING TABLES (in reverse dependency order)
-- ============================================

DROP TABLE IF EXISTS "positions" CASCADE;
DROP TABLE IF EXISTS "hierarchy_pnl" CASCADE;
DROP TABLE IF EXISTS "user_pnl" CASCADE;
DROP TABLE IF EXISTS "settlements" CASCADE;
DROP TABLE IF EXISTS "transfer_logs" CASCADE;
DROP TABLE IF EXISTS "transfer_transactions" CASCADE;
DROP TABLE IF EXISTS "transactions" CASCADE;
DROP TABLE IF EXISTS "bets" CASCADE;
DROP TABLE IF EXISTS "matches" CASCADE;
DROP TABLE IF EXISTS "match_visibility" CASCADE;
DROP TABLE IF EXISTS "site_videos" CASCADE;
DROP TABLE IF EXISTS "wallets" CASCADE;
DROP TABLE IF EXISTS "users" CASCADE;

-- ============================================
-- DROP ALL EXISTING ENUMS
-- ============================================

DROP TYPE IF EXISTS "bet_status" CASCADE;
DROP TYPE IF EXISTS "market_type" CASCADE;
DROP TYPE IF EXISTS "match_status" CASCADE;
DROP TYPE IF EXISTS "transaction_type" CASCADE;
DROP TYPE IF EXISTS "transfer_log_type" CASCADE;
DROP TYPE IF EXISTS "transfer_status" CASCADE;
DROP TYPE IF EXISTS "user_role" CASCADE;

-- ============================================
-- CREATE ENUMS
-- ============================================

CREATE TYPE "bet_status" AS ENUM ('PENDING', 'ACCEPTED', 'CONFIRMED', 'WON', 'LOST', 'CANCELLED');
CREATE TYPE "market_type" AS ENUM ('FANCY', 'BOOKMAKER', 'MATCH_ODDS');
CREATE TYPE "match_status" AS ENUM ('UPCOMING', 'LIVE', 'FINISHED', 'CANCELLED');
CREATE TYPE "transaction_type" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BET_PLACED', 'BET_WON', 'BET_LOST', 'REFUND');
CREATE TYPE "transfer_log_type" AS ENUM ('TOPUP', 'TOPDOWN');
CREATE TYPE "transfer_status" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "user_role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT', 'CLIENT', 'SETTLEMENT_ADMIN');

-- ============================================
-- CREATE TABLES (in dependency order)
-- ============================================

-- Users table
CREATE TABLE "users" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "password" TEXT NOT NULL,
    "role" "user_role" DEFAULT 'CLIENT',
    "is_active" BOOLEAN DEFAULT true,
    "parent_id" TEXT,
    "commission_percentage" DOUBLE PRECISION DEFAULT 100,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Wallets table
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "balance" DOUBLE PRECISION DEFAULT 0,
    "liability" DOUBLE PRECISION DEFAULT 0,
    "locked_exposure" DOUBLE PRECISION DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- Matches table
CREATE TABLE "matches" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "home_team" TEXT NOT NULL,
    "away_team" TEXT NOT NULL,
    "start_time" TIMESTAMP(6) NOT NULL,
    "status" "match_status" DEFAULT 'UPCOMING',
    "event_id" TEXT,
    "event_name" TEXT,
    "market_id" TEXT,
    "market_name" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- Bets table
CREATE TABLE "bets" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "odds" DOUBLE PRECISION NOT NULL,
    "sel_id" INTEGER,
    "selection_id" INTEGER,
    "bet_type" TEXT,
    "bet_name" TEXT,
    "market_name" TEXT,
    "market_type" TEXT,
    "market_id" TEXT,
    "event_id" TEXT,
    "gtype" TEXT,
    "bet_value" DOUBLE PRECISION,
    "bet_rate" DOUBLE PRECISION,
    "win_amount" DOUBLE PRECISION,
    "loss_amount" DOUBLE PRECISION,
    "settlement_id" TEXT,
    "to_return" DOUBLE PRECISION,
    "metadata" JSONB,
    "status" "bet_status" DEFAULT 'PENDING',
    "pnl" DOUBLE PRECISION DEFAULT 0,
    "is_range_consumed" BOOLEAN DEFAULT false,
    "settled_at" TIMESTAMP(6),
    "rollback_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- Transactions table
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "transaction_type" NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- Transfer Transactions table
CREATE TABLE "transfer_transactions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "commission_percentage" DOUBLE PRECISION NOT NULL,
    "final_amount" DOUBLE PRECISION NOT NULL,
    "commission_amount" DOUBLE PRECISION NOT NULL,
    "status" "transfer_status" DEFAULT 'COMPLETED',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_transactions_pkey" PRIMARY KEY ("id")
);

-- Transfer Logs table
CREATE TABLE "transfer_logs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "remarks" TEXT,
    "type" "transfer_log_type" NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_logs_pkey" PRIMARY KEY ("id")
);

-- Settlements table
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "settlement_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "market_type" "market_type" NOT NULL,
    "market_id" TEXT,
    "winner_id" TEXT,
    "settled_by" TEXT NOT NULL,
    "is_rollback" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- User Pnl table
CREATE TABLE "user_pnl" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "market_type" "market_type" NOT NULL,
    "profit" DOUBLE PRECISION DEFAULT 0,
    "loss" DOUBLE PRECISION DEFAULT 0,
    "net_pnl" DOUBLE PRECISION DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pnl_pkey" PRIMARY KEY ("id")
);

-- Hierarchy Pnl table
CREATE TABLE "hierarchy_pnl" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "event_id" TEXT NOT NULL,
    "market_type" "market_type" NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hierarchy_pnl_pkey" PRIMARY KEY ("id")
);

-- Positions table
CREATE TABLE "positions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "market_type" TEXT NOT NULL,
    "selection_id" INTEGER NOT NULL,
    "runner_name" TEXT,
    "back_stake" DOUBLE PRECISION DEFAULT 0,
    "back_odds" DOUBLE PRECISION DEFAULT 0,
    "lay_stake" DOUBLE PRECISION DEFAULT 0,
    "lay_odds" DOUBLE PRECISION DEFAULT 0,
    "pnl_if_win" DOUBLE PRECISION DEFAULT 0,
    "pnl_if_lose" DOUBLE PRECISION DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- Match Visibility table
CREATE TABLE "match_visibility" (
    "id" SERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "is_enabled" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_visibility_pkey" PRIMARY KEY ("id")
);

-- Site Videos table
CREATE TABLE "site_videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "video_url" TEXT NOT NULL,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_videos_pkey" PRIMARY KEY ("id")
);

-- ============================================
-- CREATE UNIQUE CONSTRAINTS
-- ============================================

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "wallets_user_id_key" ON "wallets"("user_id");
CREATE UNIQUE INDEX "settlements_settlement_id_key" ON "settlements"("settlement_id");
CREATE UNIQUE INDEX "user_pnl_uq_user_pnl" ON "user_pnl"("user_id", "event_id", "market_type");
CREATE UNIQUE INDEX "positions_uq_position" ON "positions"("user_id", "match_id", "market_type", "selection_id");
CREATE UNIQUE INDEX "match_visibility_event_id_key" ON "match_visibility"("event_id");
CREATE UNIQUE INDEX "site_videos_key_key" ON "site_videos"("key");

-- ============================================
-- CREATE FOREIGN KEY CONSTRAINTS
-- ============================================

ALTER TABLE "users" ADD CONSTRAINT "fk_parent" FOREIGN KEY ("parent_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "wallets" ADD CONSTRAINT "fk_wallet_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "bets" ADD CONSTRAINT "fk_bet_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "bets" ADD CONSTRAINT "fk_bet_match" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "transactions" ADD CONSTRAINT "fk_transaction_wallet" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "transfer_transactions" ADD CONSTRAINT "fk_transfer_from" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "transfer_transactions" ADD CONSTRAINT "fk_transfer_to" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "positions" ADD CONSTRAINT "fk_position_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================
-- CREATE INDEXES
-- ============================================

-- Users indexes
CREATE INDEX "idx_users_parent_id" ON "users"("parent_id");
CREATE INDEX "idx_users_parent_role" ON "users"("parent_id", "role");
CREATE INDEX "idx_users_role" ON "users"("role");

-- Matches indexes
CREATE INDEX "idx_matches_event_id" ON "matches"("event_id");
CREATE INDEX "idx_matches_status" ON "matches"("status");

-- Bets indexes
CREATE INDEX "idx_bets_created_at" ON "bets"("created_at");
CREATE INDEX "idx_bets_event_id" ON "bets"("event_id");
CREATE INDEX "idx_bets_market_id" ON "bets"("market_id");
CREATE INDEX "idx_bets_settlement_id" ON "bets"("settlement_id");
CREATE INDEX "idx_bets_status" ON "bets"("status");
CREATE INDEX "idx_bets_status_event" ON "bets"("status", "event_id");
CREATE INDEX "idx_bets_status_settlement" ON "bets"("status", "settlement_id");
CREATE INDEX "idx_bets_user_id" ON "bets"("user_id");
CREATE INDEX "idx_bets_user_status" ON "bets"("user_id", "status");
CREATE INDEX "idx_bets_user_status_created" ON "bets"("user_id", "status", "created_at");

-- Transactions indexes
CREATE INDEX "idx_transactions_type" ON "transactions"("type");
CREATE INDEX "idx_transactions_wallet_created" ON "transactions"("wallet_id", "created_at");
CREATE INDEX "idx_transactions_wallet_id" ON "transactions"("wallet_id");

-- Settlements indexes
CREATE INDEX "idx_settlements_created_at" ON "settlements"("created_at");
CREATE INDEX "idx_settlements_event_id" ON "settlements"("event_id");
CREATE INDEX "idx_settlements_event_market" ON "settlements"("event_id", "market_type");
CREATE INDEX "idx_settlements_is_rollback" ON "settlements"("is_rollback");
CREATE INDEX "idx_settlements_market_type" ON "settlements"("market_type");

-- User Pnl indexes
CREATE INDEX "idx_user_pnl_event_id" ON "user_pnl"("event_id");
CREATE INDEX "idx_user_pnl_user_event" ON "user_pnl"("user_id", "event_id");
CREATE INDEX "idx_user_pnl_user_id" ON "user_pnl"("user_id");

-- Hierarchy Pnl indexes
CREATE INDEX "idx_hierarchy_pnl_event_market_from" ON "hierarchy_pnl"("event_id", "market_type", "from_user_id");
CREATE INDEX "idx_hierarchy_pnl_from" ON "hierarchy_pnl"("from_user_id");
CREATE INDEX "idx_hierarchy_pnl_to" ON "hierarchy_pnl"("to_user_id");

-- Positions indexes
CREATE INDEX "idx_positions_match_market_sel" ON "positions"("match_id", "market_type", "selection_id");
CREATE INDEX "idx_positions_user" ON "positions"("user_id");
CREATE INDEX "idx_positions_user_match" ON "positions"("user_id", "match_id");

-- ============================================
-- COMPLETION MESSAGE
-- ============================================

DO $$
BEGIN
    RAISE NOTICE '✅ All tables, enums, constraints, and indexes have been created successfully!';
END $$;

