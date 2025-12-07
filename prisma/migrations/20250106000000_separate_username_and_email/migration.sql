-- AlterTable: Separate username and email fields
-- This migration safely migrates data from the email column (which stored username) to both username and email columns

-- Step 1: Add new username column (temporary, will rename later)
ALTER TABLE "users" ADD COLUMN "username_new" TEXT;

-- Step 2: Add new email column (nullable, will add unique constraint later)
ALTER TABLE "users" ADD COLUMN "email_new" TEXT;

-- Step 3: Copy data from old email column to new username column
-- The old "email" column actually stored usernames
-- Handle NULL values by using a default or the id
UPDATE "users" SET "username_new" = COALESCE("email", "id" || '_user');

-- Step 4: Set email_new to NULL for now (can be updated later if needed)
-- If you have actual emails stored elsewhere, update this query accordingly
UPDATE "users" SET "email_new" = NULL;

-- Step 5: Make username_new NOT NULL (should work now since we handled NULLs)
ALTER TABLE "users" ALTER COLUMN "username_new" SET NOT NULL;

-- Step 6: Drop old unique constraint on email column
DROP INDEX IF EXISTS "users_email_key";

-- Step 7: Drop old email column
ALTER TABLE "users" DROP COLUMN "email";

-- Step 8: Rename username_new to username
ALTER TABLE "users" RENAME COLUMN "username_new" TO "username";

-- Step 9: Rename email_new to email
ALTER TABLE "users" RENAME COLUMN "email_new" TO "email";

-- Step 10: Add unique constraint on username
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- Step 11: Add unique constraint on email (nullable, partial index)
CREATE UNIQUE INDEX "users_email_key" ON "users"("email") WHERE "email" IS NOT NULL;

