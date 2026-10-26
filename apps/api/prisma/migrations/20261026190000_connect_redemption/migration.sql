-- WooCommerce plugin, Task 2: the authorization-code redemption.
-- Approving a connection issues its raw credentials at once; they are kept KeyVault-encrypted
-- (a `secrets` row, `credentials_ref`) until `POST /v1/connect/token` hands them out exactly once,
-- then deleted (or deleted by the sweeper once the code expires). `redeemed_at` marks a connection
-- whose credentials were handed out; one never redeemed is revoked by the sweeper after 10 minutes.

-- AlterTable
ALTER TABLE "connect_auth_codes" ADD COLUMN     "credentials_ref" TEXT;

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "redeemed_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "connect_auth_codes" ADD CONSTRAINT "connect_auth_codes_credentials_ref_fkey" FOREIGN KEY ("credentials_ref") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The sweeper's two scans.
CREATE INDEX "connect_auth_codes_pending_credentials_idx" ON "connect_auth_codes"("expires_at")
  WHERE "credentials_ref" IS NOT NULL;
CREATE INDEX "connections_unredeemed_idx" ON "connections"("created_at")
  WHERE "redeemed_at" IS NULL AND "revoked_at" IS NULL;
