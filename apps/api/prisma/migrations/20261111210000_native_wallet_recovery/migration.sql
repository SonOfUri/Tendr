-- CreateTable
CREATE TABLE "native_wallet_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "public_key" TEXT NOT NULL,
    "credential_id" TEXT,
    "cose_public_key" TEXT,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "native_wallet_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "native_wallet_key_operations" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "candidate_key_id" TEXT,
    "recovery_key_id" TEXT,
    "revoke_key_ids" TEXT[],
    "challenge" TEXT NOT NULL,
    "proof_payload" TEXT NOT NULL,
    "payload" TEXT,
    "signature" JSONB,
    "intent_hash" TEXT,
    "claimed_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "native_wallet_key_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "native_wallet_keys_public_key_key" ON "native_wallet_keys"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallet_keys_credential_id_key" ON "native_wallet_keys"("credential_id");

-- CreateIndex
CREATE INDEX "native_wallet_keys_merchant_id_livemode_wallet_id_status_idx" ON "native_wallet_keys"("merchant_id", "livemode", "wallet_id", "status");

-- CreateIndex
CREATE INDEX "native_wallet_key_operations_merchant_id_livemode_wallet_id_idx" ON "native_wallet_key_operations"("merchant_id", "livemode", "wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "native_wallet_key_operations_status_updated_at_idx" ON "native_wallet_key_operations"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "native_wallets_id_merchant_id_livemode_key" ON "native_wallets"("id", "merchant_id", "livemode");

-- AddForeignKey
ALTER TABLE "native_wallet_keys" ADD CONSTRAINT "native_wallet_keys_wallet_id_merchant_id_livemode_fkey" FOREIGN KEY ("wallet_id", "merchant_id", "livemode") REFERENCES "native_wallets"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "native_wallet_key_operations" ADD CONSTRAINT "native_wallet_key_operations_wallet_id_merchant_id_livemod_fkey" FOREIGN KEY ("wallet_id", "merchant_id", "livemode") REFERENCES "native_wallets"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Existing wallets retain their address and original key. No on-chain changes are made.
INSERT INTO native_wallet_keys (id, merchant_id, livemode, wallet_id, kind, label, status,
  public_key, credential_id, cose_public_key, sign_count, transports, created_at, activated_at)
SELECT 'nwk_' || id, merchant_id, livemode, id, 'passkey', 'Original wallet passkey', 'active',
  public_key, credential_id, cose_public_key, sign_count, transports, created_at, created_at
FROM native_wallets;

ALTER TABLE native_wallet_keys ADD CONSTRAINT native_wallet_keys_kind_check CHECK (kind IN ('passkey', 'recovery'));
ALTER TABLE native_wallet_keys ADD CONSTRAINT native_wallet_keys_status_check CHECK (status IN ('pending', 'active', 'revoked'));
ALTER TABLE native_wallet_keys ADD CONSTRAINT native_wallet_keys_credential_check CHECK (
  (kind = 'passkey' AND credential_id IS NOT NULL AND cose_public_key IS NOT NULL) OR
  (kind = 'recovery' AND credential_id IS NULL AND cose_public_key IS NULL));
ALTER TABLE native_wallet_key_operations ADD CONSTRAINT native_wallet_key_operations_kind_check
  CHECK (kind IN ('add_passkey', 'add_recovery', 'recover', 'revoke'));
ALTER TABLE native_wallet_key_operations ADD CONSTRAINT native_wallet_key_operations_status_check
  CHECK (status IN ('registering', 'proving', 'awaiting_signature', 'submitting', 'confirmed', 'expired', 'cancelled'));
CREATE UNIQUE INDEX native_wallet_one_pending_key_operation ON native_wallet_key_operations (wallet_id)
  WHERE status IN ('registering', 'proving', 'awaiting_signature', 'submitting');
