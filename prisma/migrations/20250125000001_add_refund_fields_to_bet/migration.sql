-- AlterTable
ALTER TABLE "bets" ADD COLUMN "is_refunded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "bets" ADD COLUMN "refund_amount" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "bets" ADD COLUMN "refunded_by_bet_id" TEXT;



