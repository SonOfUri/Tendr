-- WooCommerce plugin, Task 4 (spec §5): a non-USD order total is converted to USD once, at session
-- creation. The session then carries the USD amount (`amount`, `amount_currency = 'USD'`) and keeps
-- the original amount and currency, the rate ("1 USD = fx_rate <original_currency>"), its source
-- and the rate's own timestamp. All five are null for a session created in USD or the settlement
-- asset.
ALTER TABLE "sessions"
  ADD COLUMN "original_amount" DECIMAL(38,18),
  ADD COLUMN "original_currency" TEXT,
  ADD COLUMN "fx_rate" DECIMAL(38,18),
  ADD COLUMN "fx_source" TEXT,
  ADD COLUMN "fx_as_of" TIMESTAMP(3);

-- All or none, and a converted session is always priced in USD with a positive rate.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_fx_check" CHECK (
    (
      "original_amount" IS NULL AND "original_currency" IS NULL AND "fx_rate" IS NULL
      AND "fx_source" IS NULL AND "fx_as_of" IS NULL
    ) OR (
      "original_amount" > 0 AND "original_currency" ~ '^[A-Z]{3}$' AND "fx_rate" > 0
      AND "fx_source" IS NOT NULL AND "fx_as_of" IS NOT NULL AND "amount_currency" = 'USD'
    )
  );
