-- Payment watcher (checkout Task 7).

-- Polling state per deposit address: when the next 1Click status poll is due (also the claim
-- lease of a running poll) and when polling stopped for good.
ALTER TABLE "quotes"
  ADD COLUMN "watch_next_at" TIMESTAMP(3),
  ADD COLUMN "watch_stopped_at" TIMESTAMP(3);
CREATE INDEX "quotes_watch_due_idx" ON "quotes" ("watch_next_at") WHERE "watch_stopped_at" IS NULL;

-- How a settled payment's transfer was verified: `receipt` (the destination transaction's
-- transfer event) or `oneclick` (wallet payout to a chain without a verifier: 1Click's amountOut
-- and destination tx hash).
ALTER TABLE "payments" ADD COLUMN "verified_by" TEXT;
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_check"
  CHECK ("verified_by" IS NULL OR "verified_by" IN ('receipt', 'oneclick'));

-- One payment per deposit address (quote), and one destination transfer settles one payment.
CREATE UNIQUE INDEX "payments_quote_id_key" ON "payments" ("quote_id");
CREATE UNIQUE INDEX "payments_settle_tx_key" ON "payments" ("livemode", "settle_tx")
  WHERE "settle_tx" IS NOT NULL;

-- Revenue: Tendr fee, 1Click fee (incl. spread), network fee and gas reimbursement per payment.
ALTER TYPE "revenue_source" ADD VALUE IF NOT EXISTS 'oneclick_fee';
ALTER TYPE "revenue_source" ADD VALUE IF NOT EXISTS 'network_fee';
ALTER TYPE "revenue_source" ADD VALUE IF NOT EXISTS 'gas_reimbursement';
ALTER TABLE "revenue_entries" ADD COLUMN "amount_usd" DECIMAL(18,6);
CREATE UNIQUE INDEX "revenue_entries_payment_id_source_key"
  ON "revenue_entries" ("payment_id", "source");
