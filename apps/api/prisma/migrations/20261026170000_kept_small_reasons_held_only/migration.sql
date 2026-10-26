-- Corrects 20261026160000_kept_small_reasons_remap (ruling C42). Its sanctions branch also
-- matched payments that were never HELD but were flagged held_reason 'sanctions' by a blocked
-- return (blockReturn), and rewrote their kept reason to 'sanctions'. Only a HELD payment keeps a
-- sanctions return small.
--
-- Rows the earlier remap rewrote wrongly: not HELD, flagged sanctions, kept exactly {sanctions},
-- and with no sanctions refund row (a kept return never has a row). They get back the value the
-- first backfill (20261026150000_kept_small_reasons) gave them: their first recorded refund
-- reason, else 'overpaid'.
UPDATE "payments" p
SET "kept_small_reasons" = CASE
  WHEN cardinality(p."refunds_recorded") > 0 THEN ARRAY[p."refunds_recorded"[1]]
  ELSE ARRAY['overpaid']
END
WHERE p."kept_small_overpayment"
  AND p."kept_small_reasons" = ARRAY['sanctions']
  AND p."status" <> 'HELD'
  AND p."held_reason" = 'sanctions'
  AND NOT EXISTS (
    SELECT 1 FROM "refunds" r WHERE r."payment_id" = p."id" AND r."reason" = 'sanctions'
  );
