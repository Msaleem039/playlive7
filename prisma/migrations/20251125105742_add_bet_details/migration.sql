-- AlterTable
ALTER TABLE "bets" ADD COLUMN "betName" TEXT;
ALTER TABLE "bets" ADD COLUMN "betRate" REAL;
ALTER TABLE "bets" ADD COLUMN "betType" TEXT;
ALTER TABLE "bets" ADD COLUMN "betValue" REAL;
ALTER TABLE "bets" ADD COLUMN "gtype" TEXT;
ALTER TABLE "bets" ADD COLUMN "lossAmount" REAL;
ALTER TABLE "bets" ADD COLUMN "marketName" TEXT;
ALTER TABLE "bets" ADD COLUMN "marketType" TEXT;
ALTER TABLE "bets" ADD COLUMN "metadata" JSONB;
ALTER TABLE "bets" ADD COLUMN "selectionId" INTEGER;
ALTER TABLE "bets" ADD COLUMN "settlementId" TEXT;
ALTER TABLE "bets" ADD COLUMN "toReturn" REAL;
ALTER TABLE "bets" ADD COLUMN "winAmount" REAL;
