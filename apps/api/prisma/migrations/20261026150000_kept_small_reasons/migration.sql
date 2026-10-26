-- Kept-small is decided per (payment, return reason), not per payment (ruling C40): a late
-- deposit can have two returns (`late` and `overpaid`), and keeping one small must never keep the
-- other. `kept_small_overpayment` stays as the shopper/store-facing flag.
ALTER TABLE "payments" ADD COLUMN "kept_small_reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Existing kept payments: the reason they were kept for (their recorded refund reason, else the
-- overpayment).
UPDATE "payments"
SET "kept_small_reasons" = CASE
  WHEN cardinality("refunds_recorded") > 0 THEN ARRAY["refunds_recorded"[1]]
  ELSE ARRAY['overpaid']
END
WHERE "kept_small_overpayment";
