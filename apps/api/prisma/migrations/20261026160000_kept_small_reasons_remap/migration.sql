-- Corrects the backfill of 20261026150000_kept_small_reasons (ruling C41): a payment kept small
-- before per-reason tracking was backfilled with its first recorded refund reason, else
-- 'overpaid'. Two kinds were mapped wrongly:
--   * a sanctions-held payment (HELD, or held_reason 'sanctions') kept its sanctions return;
--   * a late deposit 1Click swapped into the account (is_late, oneclick_status 'SUCCESS') kept
--     its late return.
-- Every other backfilled row keeps the value the first migration gave it (its recorded refund
-- reason, e.g. 'underpaid', else 'overpaid').
--
-- Only rows that look backfilled are touched: kept_small_overpayment is set, exactly one reason
-- is recorded, and no refund row exists for the reason the row is remapped to (a kept return never
-- has a row, so a row for that reason means the return was not the one kept).
UPDATE "payments" p
SET "kept_small_reasons" = ARRAY['sanctions']
WHERE p."kept_small_overpayment"
  AND cardinality(p."kept_small_reasons") = 1
  AND (p."status" = 'HELD' OR p."held_reason" = 'sanctions')
  AND NOT EXISTS (
    SELECT 1 FROM "refunds" r WHERE r."payment_id" = p."id" AND r."reason" = 'sanctions'
  );

UPDATE "payments" p
SET "kept_small_reasons" = ARRAY['late']
WHERE p."kept_small_overpayment"
  AND cardinality(p."kept_small_reasons") = 1
  AND p."is_late"
  AND p."oneclick_status" = 'SUCCESS'
  AND NOT (p."status" = 'HELD' OR p."held_reason" IS NOT DISTINCT FROM 'sanctions')
  AND NOT EXISTS (
    SELECT 1 FROM "refunds" r WHERE r."payment_id" = p."id" AND r."reason" = 'late'
  );
