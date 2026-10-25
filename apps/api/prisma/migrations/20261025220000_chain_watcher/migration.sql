-- Chain watcher (Task 12): the reconciliation cursor, recovery details, the limits/auto-sweep
-- mirror, restricted recovery-kit sessions, and saved addresses that can be re-added after removal.

-- AlterEnum
ALTER TYPE "webauthn_challenge_purpose" ADD VALUE 'recovery_session';

-- DropIndex
DROP INDEX "payout_allowlist_merchant_id_livemode_chain_address_key";

-- AlterTable
ALTER TABLE "dashboard_sessions" ADD COLUMN     "recovery_merchant_id" TEXT;

-- AlterTable
ALTER TABLE "merchant_accounts" ADD COLUMN     "proposals_seen" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconciled_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "recovery_requests" ADD COLUMN     "new_threshold" INTEGER,
ADD COLUMN     "nonce" BIGINT,
ADD COLUMN     "recovery_key_epoch" BIGINT;

-- CreateTable
CREATE TABLE "account_limits" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "per_tx" DECIMAL(78,0),
    "per_day" DECIMAL(78,0),
    "refund_cap" DECIMAL(78,0),
    "sweep_trigger_above" DECIMAL(78,0),
    "sweep_keep" DECIMAL(78,0),
    "sweep_saved_address_id" TEXT,
    "sweep_chain" TEXT,
    "sweep_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_limits_merchant_id_livemode_idx" ON "account_limits"("merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "account_limits_account_id_asset_key" ON "account_limits"("account_id", "asset");

-- CreateIndex
CREATE INDEX "payout_allowlist_merchant_id_livemode_idx" ON "payout_allowlist"("merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_requests_account_id_onchain_id_key" ON "recovery_requests"("account_id", "onchain_id");

-- AddForeignKey
ALTER TABLE "account_limits" ADD CONSTRAINT "account_limits_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_limits" ADD CONSTRAINT "account_limits_account_id_merchant_id_livemode_fkey" FOREIGN KEY ("account_id", "merchant_id", "livemode") REFERENCES "merchant_accounts"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A saved address is unique per (merchant, mode, chain, address) among non-revoked rows only.
CREATE UNIQUE INDEX "payout_allowlist_active_chain_address_key" ON "payout_allowlist"("merchant_id", "livemode", "chain", "address") WHERE "status" <> 'revoked';

ALTER TABLE "account_limits" ADD CONSTRAINT "account_limits_amounts_nonnegative" CHECK (
  ("per_tx" IS NULL OR "per_tx" >= 0) AND ("per_day" IS NULL OR "per_day" >= 0)
  AND ("refund_cap" IS NULL OR "refund_cap" >= 0)
  AND ("sweep_trigger_above" IS NULL OR "sweep_trigger_above" >= 0)
  AND ("sweep_keep" IS NULL OR "sweep_keep" >= 0)
);
