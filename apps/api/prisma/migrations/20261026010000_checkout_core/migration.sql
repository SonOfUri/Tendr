-- Checkout core (project 3): HELD / SCREENING_PENDING states, checkout columns, refunds linked to
-- project 2 refund proposals. The partial unique index on sessions.external_ref needs the new
-- session_status values committed first, so it lives in the next migration.

-- CreateEnum
CREATE TYPE "session_expired_reason" AS ENUM ('timeout', 'canceled');

-- CreateEnum
CREATE TYPE "held_reason" AS ENUM ('sanctions', 'screening_unavailable');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "payment_status" ADD VALUE 'HELD';
ALTER TYPE "payment_status" ADD VALUE 'SCREENING_PENDING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "refund_reason" ADD VALUE 'overpaid';
ALTER TYPE "refund_reason" ADD VALUE 'sanctions';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "session_status" ADD VALUE 'HELD';
ALTER TYPE "session_status" ADD VALUE 'SCREENING_PENDING';

-- DropIndex
DROP INDEX "sessions_merchant_id_livemode_external_ref_key";

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "checkout_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "default_fee_payer" "fee_payer" NOT NULL DEFAULT 'merchant',
ADD COLUMN     "default_gas_payer" "resolved_gas_sponsor" NOT NULL DEFAULT 'buyer';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "amount_in_usd" DECIMAL(18,6),
ADD COLUMN     "amount_out" DECIMAL(78,0),
ADD COLUMN     "held_reason" "held_reason",
ADD COLUMN     "kept_small_overpayment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "oneclick_status" TEXT,
ADD COLUMN     "overpaid_amount" DECIMAL(78,0),
ADD COLUMN     "refunded_amount" DECIMAL(78,0),
ADD COLUMN     "sender_address" TEXT,
ADD COLUMN     "sender_chain" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "amount_in_usd" DECIMAL(18,6),
ADD COLUMN     "superseded_at" TIMESTAMP(3);

-- AlterTable
-- Existing refunds take their amount from the payment and their asset from the payment's quote;
-- every later row supplies both.
ALTER TABLE "refunds" ADD COLUMN     "acknowledged_legal_at" TIMESTAMP(3),
ADD COLUMN     "amount" DECIMAL(78,0),
ADD COLUMN     "asset_id" TEXT,
ADD COLUMN     "destination" TEXT,
ADD COLUMN     "destination_chain" TEXT,
ADD COLUMN     "needs_address" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposal_id" TEXT;

UPDATE "refunds" r SET "amount" = p."amount_received", "asset_id" = q."origin_asset_id"
FROM "payments" p JOIN "quotes" q ON q."id" = p."quote_id"
WHERE p."id" = r."payment_id";

ALTER TABLE "refunds" ALTER COLUMN "amount" SET NOT NULL,
ALTER COLUMN "asset_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "cancel_url" TEXT,
ADD COLUMN     "customer_email" TEXT,
ADD COLUMN     "expired_reason" "session_expired_reason",
ADD COLUMN     "success_url" TEXT;

-- CreateIndex
CREATE INDEX "refunds_proposal_id_idx" ON "refunds"("proposal_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_proposal_id_merchant_id_livemode_fkey" FOREIGN KEY ("proposal_id", "merchant_id", "livemode") REFERENCES "account_proposals"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written checks.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_customer_email_lowercase"
  CHECK ("customer_email" IS NULL OR "customer_email" = lower("customer_email"));

ALTER TABLE "payments" ADD CONSTRAINT "payments_checkout_amounts_nonnegative" CHECK (
  ("overpaid_amount" IS NULL OR "overpaid_amount" >= 0)
  AND ("refunded_amount" IS NULL OR "refunded_amount" >= 0)
  AND ("amount_out" IS NULL OR "amount_out" >= 0)
  AND ("amount_in_usd" IS NULL OR "amount_in_usd" >= 0)
);

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_nonnegative" CHECK ("amount" >= 0);
