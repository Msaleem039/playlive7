-- One-time manual migration: tab banners per sport (cricket / soccer / tennis).
-- Run if `prisma migrate` is not used in your environment.

DO $$ BEGIN
  CREATE TYPE "sport_tab" AS ENUM ('CRICKET', 'SOCCER', 'TENNIS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "tab_banners" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tab" "sport_tab" NOT NULL,
    "image_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tab_banners_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tab_banners_tab_key" ON "tab_banners"("tab");
