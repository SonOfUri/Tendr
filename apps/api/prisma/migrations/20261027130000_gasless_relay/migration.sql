-- Gasless relay (project 5a, spec §2.3, §2.6, §3): the quote keeps the wallet it was made for (the
-- only signer the relayer accepts); a relayed submission is a gas_sponsorships row linked to its
-- quote (same session) and to the relayer's on-chain transaction; `sponsor = shopper` marks a
-- relay whose network fee the shopper paid in the token. A payment may carry several
-- gas_reimbursement revenue rows (the sponsored deduction and each shopper-paid fee leg), told
-- apart by `reference`.

-- AlterEnum
ALTER TYPE "sponsor" ADD VALUE 'shopper';

-- DropIndex
DROP INDEX "revenue_entries_payment_id_source_key";

-- AlterTable
ALTER TABLE "gas_sponsorships" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "quote_id" TEXT,
ADD COLUMN     "relayer_tx_id" TEXT,
ADD COLUMN     "signer_address" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "wallet_address" TEXT;

-- AlterTable
ALTER TABLE "revenue_entries" ADD COLUMN     "reference" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "relayer_transactions" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "from_address" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "to_address" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "gas_limit" DECIMAL(78,0) NOT NULL,
    "max_fee_per_gas" DECIMAL(78,0) NOT NULL,
    "max_priority_fee_per_gas" DECIMAL(78,0) NOT NULL,
    "raw_tx" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "tx_hashes" TEXT[],
    "cancel_tx_hash" TEXT,
    "status" "external_tx_status" NOT NULL DEFAULT 'pending',
    "purpose" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "broadcast_at" TIMESTAMP(3),
    "give_up_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "mined_hash" TEXT,
    "gas_used" DECIMAL(78,0),
    "effective_gas_price" DECIMAL(78,0),
    "last_error" TEXT,
    "lease_until" TIMESTAMP(3),
    "outcome_handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relayer_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "relayer_transactions_chain_from_address_nonce_idx" ON "relayer_transactions"("chain", "from_address", "nonce");

-- CreateIndex
CREATE INDEX "relayer_transactions_status_lease_until_idx" ON "relayer_transactions"("status", "lease_until");

-- CreateIndex
CREATE INDEX "relayer_transactions_purpose_ref_id_idx" ON "relayer_transactions"("purpose", "ref_id");

-- CreateIndex
CREATE INDEX "gas_sponsorships_quote_id_idx" ON "gas_sponsorships"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_entries_payment_id_source_reference_key" ON "revenue_entries"("payment_id", "source", "reference");

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_quote_id_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("quote_id", "session_id", "merchant_id", "livemode") REFERENCES "quotes"("id", "session_id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_relayer_tx_id_fkey" FOREIGN KEY ("relayer_tx_id") REFERENCES "relayer_transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

