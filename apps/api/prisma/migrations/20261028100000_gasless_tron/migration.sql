-- Gasless Tron USDT (project 5a, spec §2.3 Tron; rulings T9-b … T9-e): the shopper's signed
-- exact-amount approve, relayed by Tendr after just-in-time energy delegation from `gas-tron`,
-- and a ledger row per delegation so the reclaim job (`undelegateResource`) resumes after a
-- restart. Infra tables: only the relayer touches them.

-- CreateTable
CREATE TABLE "tron_approvals" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "tx_id" TEXT NOT NULL,
    "signed_tx" TEXT NOT NULL,
    "expiration" TIMESTAMP(3) NOT NULL,
    "status" "external_tx_status" NOT NULL DEFAULT 'pending',
    "broadcast_at" TIMESTAMP(3),
    "expired_seen_at" TIMESTAMP(3),
    "energy_used" BIGINT,
    "cost_sun" BIGINT,
    "cost_booked_to" TEXT,
    "payment_deadline" TIMESTAMP(3),
    "last_error" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tron_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tron_delegations" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "resource" TEXT NOT NULL,
    "receiver" TEXT NOT NULL,
    "balance_sun" BIGINT NOT NULL,
    "units" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "delegate_tx_id" TEXT NOT NULL,
    "delegate_tx" TEXT NOT NULL,
    "delegate_expiration" TIMESTAMP(3) NOT NULL,
    "delegated_at" TIMESTAMP(3),
    "delegate_fee_sun" BIGINT,
    "undelegate_tx_id" TEXT,
    "undelegate_tx" TEXT,
    "undelegate_expiration" TIMESTAMP(3),
    "undelegate_fee_sun" BIGINT,
    "expired_seen_at" TIMESTAMP(3),
    "reclaimed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tron_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tron_approvals_wallet_created_at_idx" ON "tron_approvals"("wallet", "created_at");

-- CreateIndex
CREATE INDEX "tron_approvals_quote_id_idx" ON "tron_approvals"("quote_id");

-- CreateIndex
CREATE INDEX "tron_approvals_session_id_idx" ON "tron_approvals"("session_id");

-- CreateIndex
CREATE INDEX "tron_approvals_livemode_status_updated_at_idx" ON "tron_approvals"("livemode", "status", "updated_at");

-- CreateIndex
CREATE INDEX "tron_delegations_approval_id_idx" ON "tron_delegations"("approval_id");

-- CreateIndex
CREATE INDEX "tron_delegations_livemode_status_updated_at_idx" ON "tron_delegations"("livemode", "status", "updated_at");

-- CreateIndex
CREATE INDEX "tron_delegations_receiver_status_idx" ON "tron_delegations"("receiver", "status");

-- AddForeignKey
ALTER TABLE "tron_delegations" ADD CONSTRAINT "tron_delegations_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "tron_approvals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- One approve per shopper address in flight at a time (the relayer's double-payment rule, enforced
-- again by the database).
CREATE UNIQUE INDEX "tron_approvals_in_flight_wallet_key"
  ON "tron_approvals" ("wallet")
  WHERE "status" IN ('pending', 'submitted');

-- One live delegation per receiver and resource: a second is never granted before the first is
-- reclaimed.
CREATE UNIQUE INDEX "tron_delegations_active_receiver_key"
  ON "tron_delegations" ("receiver", "resource")
  WHERE "status" IN ('delegating', 'delegated', 'reclaiming');
