-- Gas-fee sweep and gas balance alerts (project 5a, Task 12): one row per sweep of a gas-fee
-- account's token into USDC on NEAR, and the per-key throttle of operator alerts. No key material
-- is stored: the gas-fee keys stay in the key vault.

-- CreateEnum
CREATE TYPE "fee_sweep_status" AS ENUM ('planned', 'executed', 'failed', 'needs_gas');

-- CreateTable
CREATE TABLE "fee_sweeps" (
    "id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "family" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "account_address" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "amount_usd" DECIMAL(18,6) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "fee_sweep_status" NOT NULL DEFAULT 'planned',
    "quote_id" TEXT,
    "deposit_address" TEXT,
    "destination_asset" TEXT,
    "recipient" TEXT,
    "tx_hash" TEXT,
    "last_error" TEXT,
    "lease_until" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_sweeps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gas_ops_alerts" (
    "key" TEXT NOT NULL,
    "last_notified_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gas_ops_alerts_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "fee_sweeps_livemode_chain_account_address_asset_id_status_idx" ON "fee_sweeps"("livemode", "chain", "account_address", "asset_id", "status");

-- At most one open plan (planned, or waiting for gas) per account and token.
CREATE UNIQUE INDEX "fee_sweeps_one_open_plan" ON "fee_sweeps"("livemode", "chain", "account_address", "asset_id") WHERE "status" IN ('planned', 'needs_gas');

ALTER TABLE "fee_sweeps" ADD CONSTRAINT "fee_sweeps_amount_check" CHECK ("amount" > 0);
ALTER TABLE "fee_sweeps" ADD CONSTRAINT "fee_sweeps_amount_usd_check" CHECK ("amount_usd" >= 0);
