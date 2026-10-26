-- WooCommerce plugin, Task 5 (spec §7): merchant-initiated refunds (`POST /v1/refunds`).
--
-- A store refund is a `refunds` row with reason `merchant`, returned to the wallet that paid
-- through the checkout-core return path as a signer-approved system draft. A payment may have
-- several (partial refunds, as in WooCommerce), each keyed by the store's own `external_ref`
-- (the WooCommerce refund id). `requested_amount_usd` is what the store asked to return; `amount`
-- is that plus `return_fee` (the merchant pays the network cost), in asset base units. `note` is
-- the store's free-text reason.
--
-- A SETTLED payment whose merchant refunds executed is PARTIALLY_REFUNDED, then REFUNDED.
--
-- The new enum values must be committed before an index predicate or CHECK can name them, so the
-- indexes and the CHECK are in the next migration (merchant_refunds_indexes). The per-(payment,
-- reason) unique index is dropped here and recreated there as a partial one that leaves
-- `merchant` rows out.
ALTER TYPE "refund_reason" ADD VALUE 'merchant';
ALTER TYPE "payment_status" ADD VALUE 'PARTIALLY_REFUNDED';

ALTER TABLE "refunds"
  ADD COLUMN "external_ref" TEXT,
  ADD COLUMN "requested_amount_usd" DECIMAL(18,2),
  ADD COLUMN "note" TEXT;

DROP INDEX "refunds_payment_id_reason_key";
