-- CreateEnum
CREATE TYPE "merchant_account_kind" AS ENUM ('contract', 'native_intents');

-- CreateEnum
CREATE TYPE "native_payout_status" AS ENUM ('awaiting_signature', 'submitting', 'submitted', 'completed', 'refunded', 'failed', 'expired');

-- AlterEnum
ALTER TYPE "webauthn_challenge_purpose" ADD VALUE 'native_wallet_registration';

-- AlterTable
ALTER TABLE "webauthn_challenges" ADD COLUMN     "livemode" BOOLEAN,
ADD COLUMN     "merchant_id" TEXT;

-- AlterTable
ALTER TABLE "merchant_accounts" ADD COLUMN     "kind" "merchant_account_kind" NOT NULL DEFAULT 'contract';

-- CreateTable
CREATE TABLE "native_wallets" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "cose_public_key" TEXT NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "activation_payload" TEXT,
    "activation_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_payouts" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT NOT NULL,
    "proposal_id" TEXT,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "destination_asset" TEXT NOT NULL,
    "destination_chain" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "deposit_address" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "native_payout_status" NOT NULL DEFAULT 'awaiting_signature',
    "signature" JSONB,
    "intent_hash" TEXT,
    "provider_status" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_account_id_key" ON "native_wallets"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_credential_id_key" ON "native_wallets"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_public_key_key" ON "native_wallets"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_merchant_id_livemode_key" ON "native_wallets"("merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_account_id_merchant_id_livemode_key" ON "native_wallets"("account_id", "merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "native_payouts_proposal_id_key" ON "native_payouts"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "native_payouts_deposit_address_key" ON "native_payouts"("deposit_address");

-- CreateIndex
CREATE INDEX "native_payouts_status_updated_at_idx" ON "native_payouts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "native_payouts_merchant_id_livemode_idx" ON "native_payouts"("merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "native_payouts_proposal_id_merchant_id_livemode_key" ON "native_payouts"("proposal_id", "merchant_id", "livemode");

-- AddForeignKey
ALTER TABLE "native_wallets" ADD CONSTRAINT "native_wallets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_wallets" ADD CONSTRAINT "native_wallets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_wallets" ADD CONSTRAINT "native_wallets_account_id_merchant_id_livemode_fkey" FOREIGN KEY ("account_id", "merchant_id", "livemode") REFERENCES "merchant_accounts"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "native_payouts" ADD CONSTRAINT "native_payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "native_payouts" ADD CONSTRAINT "native_payouts_account_id_merchant_id_livemode_fkey" FOREIGN KEY ("account_id", "merchant_id", "livemode") REFERENCES "merchant_accounts"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "native_payouts" ADD CONSTRAINT "native_payouts_proposal_id_merchant_id_livemode_fkey" FOREIGN KEY ("proposal_id", "merchant_id", "livemode") REFERENCES "account_proposals"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

