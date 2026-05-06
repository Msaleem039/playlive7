-- Add per-client configurable maximum winning cap.
ALTER TABLE "users"
ADD COLUMN "max_win_amount" DOUBLE PRECISION;
