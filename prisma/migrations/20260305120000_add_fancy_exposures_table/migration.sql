-- CreateTable
CREATE TABLE "fancy_exposures" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "market_id" TEXT NOT NULL,
    "selection_id" INTEGER NOT NULL,
    "remaining_exposure" DOUBLE PRECISION NOT NULL,
    "last_bet_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fancy_exposures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fancy_exposures_user_market_selection_key" ON "fancy_exposures"("user_id", "market_id", "selection_id");

-- CreateIndex
CREATE INDEX "idx_fancy_exposures_user_id" ON "fancy_exposures"("user_id");

-- AddForeignKey
ALTER TABLE "fancy_exposures" ADD CONSTRAINT "fk_fancy_exposure_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
