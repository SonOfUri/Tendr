-- Idempotency keys are namespaced per principal (spec §3): (merchant, mode, principal, key).
-- Existing rows are short-lived (24 h TTL) and get principal_ref '' — they can no longer be
-- replayed by any real principal and expire on their own.

-- AlterTable
ALTER TABLE "idempotency_keys" ADD COLUMN "principal_ref" TEXT NOT NULL DEFAULT '';
ALTER TABLE "idempotency_keys" ALTER COLUMN "principal_ref" DROP DEFAULT;

-- DropIndex
DROP INDEX "idempotency_keys_merchant_id_livemode_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_merchant_id_livemode_principal_ref_key_key" ON "idempotency_keys"("merchant_id", "livemode", "principal_ref", "key");
