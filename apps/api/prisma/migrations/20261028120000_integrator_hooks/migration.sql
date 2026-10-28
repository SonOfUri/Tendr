-- Integrator hooks (project 5a, Task 11): one hook call per payment, its retry window, the
-- one-time failure alert, the actual gas cost of its attempts, and the `hook` sponsorship method
-- (a hook call's gas above the quoted estimate, recognised as Tendr's loss).

-- AlterEnum
ALTER TYPE "sponsorship_method" ADD VALUE 'hook';

-- AlterTable
ALTER TABLE "hook_calls" ADD COLUMN     "alerted_at" TIMESTAMP(3),
ADD COLUMN     "cost_usd" DECIMAL(18,6),
ADD COLUMN     "retry_until" TIMESTAMP(3),
ADD COLUMN     "succeeded_at" TIMESTAMP(3);

-- Existing calls (none were ever delivered before this release) get the 3-day window.
UPDATE "hook_calls" SET "retry_until" = "created_at" + INTERVAL '3 days' WHERE "retry_until" IS NULL;
ALTER TABLE "hook_calls" ALTER COLUMN "retry_until" SET NOT NULL;

ALTER TABLE "hook_calls" ADD CONSTRAINT "hook_calls_cost_usd_check" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0);

-- DropIndex
DROP INDEX "hook_calls_payment_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "hook_calls_payment_id_key" ON "hook_calls"("payment_id");
