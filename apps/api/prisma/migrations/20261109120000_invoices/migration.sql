-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('awaiting_verification', 'open', 'processing', 'paid', 'rejected', 'payment_review');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "invoices_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "native_payouts" ADD COLUMN     "invoice_id" TEXT;

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "contractor_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "due_date" TEXT,
    "destination_asset" TEXT NOT NULL,
    "destination_chain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'awaiting_verification',
    "access_token_hash" TEXT NOT NULL,
    "verify_expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_access_token_hash_key" ON "invoices"("access_token_hash");

-- CreateIndex
CREATE INDEX "invoices_merchant_id_livemode_status_created_at_idx" ON "invoices"("merchant_id", "livemode", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_merchant_id_livemode_key" ON "invoices"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_merchant_id_livemode_email_reference_key" ON "invoices"("merchant_id", "livemode", "email", "reference");

-- AddForeignKey
ALTER TABLE "native_payouts" ADD CONSTRAINT "native_payouts_invoice_id_merchant_id_livemode_fkey" FOREIGN KEY ("invoice_id", "merchant_id", "livemode") REFERENCES "invoices"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A single invoice can have only one active or successful payout, even across racing requests.
CREATE UNIQUE INDEX native_payouts_one_active_invoice ON native_payouts(invoice_id)
  WHERE invoice_id IS NOT NULL AND status IN ('awaiting_signature', 'submitting', 'submitted', 'completed');
ALTER TABLE native_payouts ADD CONSTRAINT native_payouts_one_purpose CHECK (invoice_id IS NULL OR proposal_id IS NULL);
ALTER TABLE invoices ADD CONSTRAINT invoices_positive_amount CHECK (
  amount ~ '^[1-9][0-9]{0,38}$' AND amount::numeric <= 340282366920938463463374607431768211455
);
