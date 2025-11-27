-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_wallets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "balance" REAL NOT NULL DEFAULT 0,
    "liability" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_wallets" ("balance", "createdAt", "id", "updatedAt", "userId") SELECT "balance", "createdAt", "id", "updatedAt", "userId" FROM "wallets";
DROP TABLE "wallets";
ALTER TABLE "new_wallets" RENAME TO "wallets";
CREATE UNIQUE INDEX "wallets_userId_key" ON "wallets"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
