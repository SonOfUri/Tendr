-- Merchant webhook delivery state (checkout Task 9). One row per (endpoint, event): `attempt`
-- counts sends, `next_retry_at` is the next scheduled send (also the claim lease while a send is
-- in flight), and retries stop 3 days after `first_attempt_at` (status `failed`; a manual resend
-- is still allowed).
ALTER TABLE "webhook_deliveries"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "first_attempt_at" TIMESTAMP(3),
  ADD COLUMN "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "delivered_at" TIMESTAMP(3),
  ADD COLUMN "last_error" TEXT;

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_status_check"
  CHECK ("status" IN ('pending', 'delivered', 'failed'));

CREATE INDEX "webhook_deliveries_status_next_retry_at_idx"
  ON "webhook_deliveries"("status", "next_retry_at");
