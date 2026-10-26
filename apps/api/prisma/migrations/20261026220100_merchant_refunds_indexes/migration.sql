-- WooCommerce plugin, Task 5: the uniqueness of returns (see merchant_refunds).
--
-- Automatic returns stay one per payment and reason: the watcher hook and the sweeper are
-- idempotent on it. Not expressible in Prisma (partial unique index), maintained here.
CREATE UNIQUE INDEX "refunds_payment_id_reason_key"
  ON "refunds" ("payment_id", "reason")
  WHERE "reason" <> 'merchant';

-- Merchant refunds: one per payment and store reference. Automatic rows have no external_ref
-- (NULLs are distinct), so this plain index never binds them.
CREATE UNIQUE INDEX "refunds_payment_id_external_ref_key" ON "refunds" ("payment_id", "external_ref");

-- A merchant refund always carries its reference and requested amount; an automatic one never
-- does (so no code path can take one for the other).
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_fields_check" CHECK (
  (
    "reason" = 'merchant' AND "external_ref" IS NOT NULL AND "requested_amount_usd" > 0
  ) OR (
    "reason" <> 'merchant' AND "external_ref" IS NULL AND "requested_amount_usd" IS NULL
    AND "note" IS NULL
  )
);
