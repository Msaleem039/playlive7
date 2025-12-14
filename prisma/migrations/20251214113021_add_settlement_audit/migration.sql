-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('FANCY', 'BOOKMAKER', 'MATCH_ODDS');

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "marketId" TEXT,
    "winnerId" TEXT,
    "settledBy" TEXT NOT NULL,
    "isRollback" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_pnl" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "profit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loss" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pnl_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "bets" ADD COLUMN "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "settledAt" TIMESTAMP(3),
ADD COLUMN "rollbackAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "settlements_settlementId_key" ON "settlements"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "user_pnl_userId_eventId_marketType_key" ON "user_pnl"("userId", "eventId", "marketType");

