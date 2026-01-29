-- SQL script to make columns NOT NULL to match Prisma schema
-- Run this in your database SQL editor after updating existing NULL values
-- Note: Uses snake_case column names as they exist in the database

BEGIN;

-- Update NULL values with defaults before making columns NOT NULL
UPDATE users SET role = 'CLIENT' WHERE role IS NULL;
UPDATE users SET is_active = true WHERE is_active IS NULL;
UPDATE users SET commission_percentage = 100 WHERE commission_percentage IS NULL;
UPDATE users SET created_at = NOW() WHERE created_at IS NULL;
UPDATE users SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE wallets SET balance = 0 WHERE balance IS NULL;
UPDATE wallets SET liability = 0 WHERE liability IS NULL;
UPDATE wallets SET locked_exposure = 0 WHERE locked_exposure IS NULL;
UPDATE wallets SET created_at = NOW() WHERE created_at IS NULL;
UPDATE wallets SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE matches SET status = 'UPCOMING' WHERE status IS NULL;
UPDATE matches SET created_at = NOW() WHERE created_at IS NULL;
UPDATE matches SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE bets SET status = 'PENDING' WHERE status IS NULL;
UPDATE bets SET pnl = 0 WHERE pnl IS NULL;
UPDATE bets SET is_range_consumed = false WHERE is_range_consumed IS NULL;
UPDATE bets SET created_at = NOW() WHERE created_at IS NULL;
UPDATE bets SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE transactions SET created_at = NOW() WHERE created_at IS NULL;

UPDATE transfer_transactions SET status = 'COMPLETED' WHERE status IS NULL;
UPDATE transfer_transactions SET created_at = NOW() WHERE created_at IS NULL;
UPDATE transfer_transactions SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE transfer_logs SET created_at = NOW() WHERE created_at IS NULL;

UPDATE settlements SET is_rollback = false WHERE is_rollback IS NULL;
UPDATE settlements SET created_at = NOW() WHERE created_at IS NULL;

UPDATE user_pnl SET profit = 0 WHERE profit IS NULL;
UPDATE user_pnl SET loss = 0 WHERE loss IS NULL;
UPDATE user_pnl SET net_pnl = 0 WHERE net_pnl IS NULL;
UPDATE user_pnl SET created_at = NOW() WHERE created_at IS NULL;
UPDATE user_pnl SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE hierarchy_pnl SET created_at = NOW() WHERE created_at IS NULL;

UPDATE positions SET back_stake = 0 WHERE back_stake IS NULL;
UPDATE positions SET back_odds = 0 WHERE back_odds IS NULL;
UPDATE positions SET lay_stake = 0 WHERE lay_stake IS NULL;
UPDATE positions SET lay_odds = 0 WHERE lay_odds IS NULL;
UPDATE positions SET pnl_if_win = 0 WHERE pnl_if_win IS NULL;
UPDATE positions SET pnl_if_lose = 0 WHERE pnl_if_lose IS NULL;
UPDATE positions SET created_at = NOW() WHERE created_at IS NULL;
UPDATE positions SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE match_visibility SET is_enabled = true WHERE is_enabled IS NULL;
UPDATE match_visibility SET created_at = NOW() WHERE created_at IS NULL;
UPDATE match_visibility SET updated_at = NOW() WHERE updated_at IS NULL;

UPDATE site_videos SET is_active = true WHERE is_active IS NULL;
UPDATE site_videos SET created_at = NOW() WHERE created_at IS NULL;
UPDATE site_videos SET updated_at = NOW() WHERE updated_at IS NULL;

-- Now make columns NOT NULL (using snake_case column names)
ALTER TABLE users 
  ALTER COLUMN role SET NOT NULL,
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN commission_percentage SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE wallets 
  ALTER COLUMN balance SET NOT NULL,
  ALTER COLUMN liability SET NOT NULL,
  ALTER COLUMN locked_exposure SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE matches 
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE bets 
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN pnl SET NOT NULL,
  ALTER COLUMN is_range_consumed SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE transactions 
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE transfer_transactions 
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE transfer_logs 
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE settlements 
  ALTER COLUMN is_rollback SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE user_pnl 
  ALTER COLUMN profit SET NOT NULL,
  ALTER COLUMN loss SET NOT NULL,
  ALTER COLUMN net_pnl SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE hierarchy_pnl 
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE positions 
  ALTER COLUMN back_stake SET NOT NULL,
  ALTER COLUMN back_odds SET NOT NULL,
  ALTER COLUMN lay_stake SET NOT NULL,
  ALTER COLUMN lay_odds SET NOT NULL,
  ALTER COLUMN pnl_if_win SET NOT NULL,
  ALTER COLUMN pnl_if_lose SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE match_visibility 
  ALTER COLUMN is_enabled SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE site_videos 
  ALTER COLUMN is_active SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;

