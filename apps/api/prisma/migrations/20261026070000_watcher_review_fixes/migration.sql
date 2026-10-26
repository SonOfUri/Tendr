-- Payment watcher review fixes.

-- Which origin transactions' senders have been resolved (and screened): settlement requires every
-- origin tx of the deposit (a top-up adds one) to be covered.
ALTER TABLE "payments" ADD COLUMN "sender_origin_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- Refund reasons already recorded (payment.refunded + return-to-sender happen once per reason).
ALTER TABLE "payments" ADD COLUMN "refunds_recorded" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- One destination transaction may settle several payments (batched settlements), but one transfer
-- event settles at most one: claims are per (tx, receipt, event) instead of per tx.
DROP INDEX IF EXISTS "payments_settle_tx_key";

CREATE TABLE "settlement_claims" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "payment_id" TEXT NOT NULL,
  "tx_hash" TEXT NOT NULL,
  "receipt_id" TEXT NOT NULL,
  "event_key" TEXT NOT NULL,
  "amount" DECIMAL(78,0) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_claims_event_key"
  ON "settlement_claims" ("livemode", "tx_hash", "receipt_id", "event_key");
CREATE UNIQUE INDEX "settlement_claims_payment_id_key" ON "settlement_claims" ("payment_id");
CREATE INDEX "settlement_claims_merchant_id_idx" ON "settlement_claims" ("merchant_id");
ALTER TABLE "settlement_claims" ADD CONSTRAINT "settlement_claims_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_claims" ADD CONSTRAINT "settlement_claims_payment_id_merchant_id_livemode_fkey"
  FOREIGN KEY ("payment_id", "merchant_id", "livemode")
  REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;
