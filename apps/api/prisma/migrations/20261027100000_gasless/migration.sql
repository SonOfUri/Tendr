-- Gasless payments, relayer and integrator hooks (project 5a), Task 1: the gas data model.
-- - `gas_policies`: one per merchant and mode; amounts non-negative, cap within the budget.
-- - `gas_budget_months`: the month's (UTC, YYYY-MM) reserved and spent sponsorship per mode.
-- - `gas_sponsorships`: shopper-paid fee (mode, asset, amount), the quoted estimate and the
--   budget reservation state.
-- - `hook_calls`: the payment notified, the hook data sent, retry schedule, lease and last error.
-- - New sponsorship methods: forwarder, meta_tx (NEAR NEP-366), kora (Pimlico on Solana).
-- - Backfill (spec §8.4): a store whose default gas payer is the merchant gets an ENABLED policy
--   with the default limits in both modes.

CREATE TYPE "fee_mode" AS ENUM ('token', 'native');

CREATE TYPE "gas_reservation_state" AS ENUM ('reserved', 'settled', 'released');

ALTER TYPE "sponsorship_method" ADD VALUE 'forwarder';
ALTER TYPE "sponsorship_method" ADD VALUE 'meta_tx';
ALTER TYPE "sponsorship_method" ADD VALUE 'kora';

-- `hook_calls` has never been written (hooks ship in this project), so the new required columns
-- need no default.
ALTER TABLE "hook_calls"
  ADD COLUMN "payment_id" TEXT NOT NULL,
  ADD COLUMN "hook_data" JSONB NOT NULL,
  ADD COLUMN "next_retry_at" TIMESTAMP(3),
  ADD COLUMN "lease_until" TIMESTAMP(3),
  ADD COLUMN "last_error" TEXT;

ALTER TABLE "gas_sponsorships"
  ADD COLUMN "fee_mode" "fee_mode",
  ADD COLUMN "fee_asset" TEXT,
  ADD COLUMN "fee_amount" DECIMAL(78,0),
  ADD COLUMN "estimate_usd" DECIMAL(18,6),
  ADD COLUMN "reservation_state" "gas_reservation_state";

ALTER TABLE "gas_sponsorships"
  ADD CONSTRAINT "gas_sponsorships_amounts_check" CHECK (
    ("fee_amount" IS NULL OR "fee_amount" >= 0)
    AND ("estimate_usd" IS NULL OR "estimate_usd" >= 0)
    AND ("cost_usd" IS NULL OR "cost_usd" >= 0)
  );

CREATE TABLE "gas_budget_months" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "month" TEXT NOT NULL,
    "reserved_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "spent_usd" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gas_budget_months_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gas_budget_months_check" CHECK (
      "month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      AND "reserved_usd" >= 0
      AND "spent_usd" >= 0
      AND "count" >= 0
    )
);

CREATE UNIQUE INDEX "gas_budget_months_merchant_id_livemode_month_key" ON "gas_budget_months"("merchant_id", "livemode", "month");

CREATE UNIQUE INDEX "gas_policies_merchant_id_livemode_key" ON "gas_policies"("merchant_id", "livemode");

ALTER TABLE "gas_policies"
  ADD CONSTRAINT "gas_policies_amounts_check" CHECK (
    "per_payment_cap_usd" >= 0
    AND "monthly_budget_usd" >= 0
    AND "min_order_usd" >= 0
    AND "per_payment_cap_usd" <= "monthly_budget_usd"
  );

CREATE INDEX "hook_calls_payment_id_idx" ON "hook_calls"("payment_id");

CREATE INDEX "hook_calls_status_next_retry_at_idx" ON "hook_calls"("status", "next_retry_at");

ALTER TABLE "gas_budget_months" ADD CONSTRAINT "gas_budget_months_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hook_calls" ADD CONSTRAINT "hook_calls_payment_id_merchant_id_livemode_fkey" FOREIGN KEY ("payment_id", "merchant_id", "livemode") REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Policy backfill. Defaults = DEFAULT_GAS_POLICY in @tendr/contracts ($1 per payment, $50 per
-- month, no minimum order, every supported chain except Ethereum mainnet, any token). Ids are
-- `gpol_` + 26 upper-case hex characters (valid Crockford base32, like the app's ULIDs).
-- BEGIN gas policy backfill
INSERT INTO "gas_policies" (
  "id", "merchant_id", "livemode", "enabled", "per_payment_cap_usd", "monthly_budget_usd",
  "min_order_usd", "chains", "tokens", "first_time_only", "updated_at"
)
SELECT
  'gpol_' || upper(substr(md5(random()::text || clock_timestamp()::text || m."id" || modes.livemode::text), 1, 26)),
  m."id",
  modes.livemode,
  true,
  1,
  50,
  0,
  ARRAY['base', 'arb', 'op', 'pol', 'bsc', 'avax', 'gnosis', 'bera', 'sol', 'near', 'tron']::TEXT[],
  ARRAY[]::TEXT[],
  false,
  CURRENT_TIMESTAMP
FROM "merchants" m
CROSS JOIN (VALUES (false), (true)) AS modes(livemode)
WHERE m."default_gas_payer" = 'merchant'
ON CONFLICT ("merchant_id", "livemode") DO NOTHING;
-- END gas policy backfill
