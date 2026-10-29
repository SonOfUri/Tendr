-- Gasless relayer final fix wave.
--
-- 1. Fee sweeps (final review m2, Task 12): a sweep is `executed` only once its transfer is
--    confirmed on chain. `broadcast` = sent, outcome reconciled by `tx_hash`; it blocks re-planning
--    of the account and token meanwhile. `broadcast_at` is when it was sent.
-- 2. Integrator hooks (final review m1): manual resends are counted (at most 3 per hook call).
-- 3. Hook gas shortfall rows (Task 11 re-review b): their payment moves from
--    `recovered_from_payment_id` (nothing was recovered from it) to `hook_payment_id`.

-- AlterEnum
ALTER TYPE "fee_sweep_status" ADD VALUE 'broadcast';

-- AlterTable
ALTER TABLE "fee_sweeps" ADD COLUMN     "broadcast_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "hook_calls" ADD COLUMN     "manual_resends" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "gas_sponsorships" ADD COLUMN     "hook_payment_id" TEXT;

-- CreateIndex
CREATE INDEX "gas_sponsorships_hook_payment_id_idx" ON "gas_sponsorships"("hook_payment_id");

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_hook_payment_id_merchant_id_livemode_fkey" FOREIGN KEY ("hook_payment_id", "merchant_id", "livemode") REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Existing hook shortfall rows: their key moves to the new column.
UPDATE "gas_sponsorships"
SET "hook_payment_id" = "recovered_from_payment_id", "recovered_from_payment_id" = NULL
WHERE "method" = 'hook' AND "recovered_from_payment_id" IS NOT NULL;
