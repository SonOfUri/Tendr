-- CreateEnum
CREATE TYPE "email_token_purpose" AS ENUM ('verify', 'login', 'invite');

-- CreateEnum
CREATE TYPE "merchant_account_status" AS ENUM ('provisioning', 'active', 'failed');

-- CreateEnum
CREATE TYPE "proposal_kind" AS ENUM ('add_signer', 'remove_signer', 'add_signer_key', 'remove_signer_key', 'set_threshold', 'set_origins', 'rotate_recovery_key', 'add_saved_address', 'remove_saved_address', 'set_limits', 'set_refund_cap', 'set_auto_sweep', 'clear_auto_sweep', 'withdraw', 'refund', 'upgrade', 'set_settlement');

-- CreateEnum
CREATE TYPE "proposal_status" AS ENUM ('draft', 'pending', 'timelocked', 'executing', 'executed', 'cancelled', 'expired', 'failed');

-- CreateEnum
CREATE TYPE "recovery_status" AS ENUM ('pending', 'cancelled', 'executed', 'failed');

-- AlterEnum
ALTER TYPE "account_key_kind" ADD VALUE 'recovery';

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- ── Hand-written: merchant_users becomes a membership of a person ────────────
-- Existing memberships each get a `users` row (one per distinct lower-cased email) with a
-- `per_<ULID>` id generated here; application code generates every later id.
CREATE FUNCTION pg_temp.tendr_ulid() RETURNS TEXT AS $$
DECLARE
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms BIGINT := floor(extract(epoch FROM clock_timestamp()) * 1000);
  out TEXT := '';
BEGIN
  FOR i IN REVERSE 9..0 LOOP
    out := out || substr(alphabet, ((ms >> (5 * i)) & 31)::INT + 1, 1);
  END LOOP;
  FOR i IN 1..16 LOOP
    out := out || substr(alphabet, floor(random() * 32)::INT + 1, 1);
  END LOOP;
  RETURN out;
END;
$$ LANGUAGE plpgsql;

DROP INDEX "merchant_users_merchant_id_email_key";

ALTER TABLE "merchant_users" ADD COLUMN "is_signer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "user_id" TEXT;

INSERT INTO "users" ("id", "email", "updated_at")
SELECT 'per_' || pg_temp.tendr_ulid(), e.email, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT lower("email") AS email FROM "merchant_users") e;

UPDATE "merchant_users" mu SET "user_id" = u."id"
FROM "users" u WHERE u."email" = lower(mu."email");

ALTER TABLE "merchant_users" ALTER COLUMN "user_id" SET NOT NULL,
DROP COLUMN "auth_provider",
DROP COLUMN "email",
DROP COLUMN "mfa_enabled";

-- ── Hand-written: account_keys gain a mode and an optional owner ─────────────
-- Existing keys take their mode from the account name (`*.near` is live, anything else test).
ALTER TABLE "account_keys" ADD COLUMN "credential_id" TEXT,
ADD COLUMN "livemode" BOOLEAN,
ADD COLUMN "user_id" TEXT;

UPDATE "account_keys" SET "livemode" = ("near_account_id" LIKE '%.near');

ALTER TABLE "account_keys" ALTER COLUMN "livemode" SET NOT NULL;

-- CreateTable
CREATE TABLE "webauthn_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" JSONB NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "device_label" TEXT,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "email_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_invites" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "merchant_user_role" NOT NULL,
    "make_signer" BOOLEAN NOT NULL DEFAULT false,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_accounts" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "near_account_id" TEXT NOT NULL,
    "contract_code_hash" TEXT,
    "threshold" INTEGER NOT NULL,
    "signer_epoch" BIGINT NOT NULL DEFAULT 0,
    "status" "merchant_account_status" NOT NULL DEFAULT 'provisioning',
    "created_tx" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_proposals" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT NOT NULL,
    "onchain_id" TEXT NOT NULL,
    "kind" "proposal_kind" NOT NULL,
    "action" JSONB NOT NULL,
    "salt" TEXT NOT NULL,
    "status" "proposal_status" NOT NULL DEFAULT 'draft',
    "created_by_user_id" TEXT NOT NULL,
    "ready_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "last_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_approvals" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "signer_epoch" BIGINT NOT NULL,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_requests" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT NOT NULL,
    "onchain_id" TEXT,
    "executes_at" TIMESTAMP(3) NOT NULL,
    "status" "recovery_status" NOT NULL DEFAULT 'pending',
    "new_signer_ids" TEXT[],
    "start_tx_hash" TEXT,
    "cancel_tx_hash" TEXT,
    "execute_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_id_user_id_key" ON "webauthn_credentials"("id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_sessions_token_hash_key" ON "dashboard_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "dashboard_sessions_user_id_idx" ON "dashboard_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_email_purpose_idx" ON "email_tokens"("email", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_invites_token_hash_key" ON "merchant_invites"("token_hash");

-- CreateIndex
CREATE INDEX "merchant_invites_merchant_id_idx" ON "merchant_invites"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_accounts_near_account_id_key" ON "merchant_accounts"("near_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_accounts_merchant_id_livemode_key" ON "merchant_accounts"("merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_accounts_id_merchant_id_livemode_key" ON "merchant_accounts"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "account_proposals_merchant_id_livemode_status_idx" ON "account_proposals"("merchant_id", "livemode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "account_proposals_account_id_onchain_id_key" ON "account_proposals"("account_id", "onchain_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_proposals_id_merchant_id_livemode_key" ON "account_proposals"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "account_approvals_merchant_id_idx" ON "account_approvals"("merchant_id");

-- CreateIndex
CREATE INDEX "account_approvals_user_id_idx" ON "account_approvals"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_approvals_proposal_id_user_id_key" ON "account_approvals"("proposal_id", "user_id");

-- CreateIndex
CREATE INDEX "recovery_requests_merchant_id_livemode_status_idx" ON "recovery_requests"("merchant_id", "livemode", "status");

-- CreateIndex
CREATE INDEX "account_keys_user_id_idx" ON "account_keys"("user_id");

-- CreateIndex
CREATE INDEX "merchant_users_user_id_idx" ON "merchant_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_users_merchant_id_user_id_key" ON "merchant_users"("merchant_id", "user_id");

-- AddForeignKey
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "merchant_invites" ADD CONSTRAINT "merchant_invites_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_credential_id_user_id_fkey" FOREIGN KEY ("credential_id", "user_id") REFERENCES "webauthn_credentials"("id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "merchant_accounts" ADD CONSTRAINT "merchant_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_proposals" ADD CONSTRAINT "account_proposals_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_proposals" ADD CONSTRAINT "account_proposals_account_id_merchant_id_livemode_fkey" FOREIGN KEY ("account_id", "merchant_id", "livemode") REFERENCES "merchant_accounts"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_proposals" ADD CONSTRAINT "account_proposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_approvals" ADD CONSTRAINT "account_approvals_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_approvals" ADD CONSTRAINT "account_approvals_proposal_id_merchant_id_livemode_fkey" FOREIGN KEY ("proposal_id", "merchant_id", "livemode") REFERENCES "account_proposals"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_approvals" ADD CONSTRAINT "account_approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "account_approvals" ADD CONSTRAINT "account_approvals_credential_id_user_id_fkey" FOREIGN KEY ("credential_id", "user_id") REFERENCES "webauthn_credentials"("id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_account_id_merchant_id_livemode_fkey" FOREIGN KEY ("account_id", "merchant_id", "livemode") REFERENCES "merchant_accounts"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── Hand-written checks ──────────────────────────────────────────────────────
-- Emails are compared lower-cased everywhere; store them that way.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "merchant_invites" ADD CONSTRAINT "merchant_invites_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_email_lowercase" CHECK ("email" = lower("email"));

-- On-chain ids are 32 bytes as lower-case hex.
ALTER TABLE "account_proposals" ADD CONSTRAINT "account_proposals_onchain_id_hex" CHECK ("onchain_id" ~ '^[0-9a-f]{64}$');
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_onchain_id_hex" CHECK ("onchain_id" ~ '^[0-9a-f]{64}$');

ALTER TABLE "merchant_accounts" ADD CONSTRAINT "merchant_accounts_threshold_positive" CHECK ("threshold" >= 1);

-- The (credential_id, user_id) FK is MATCH SIMPLE, so a NULL user_id would skip it: a key that
-- names a passkey must also name the passkey's owner.
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_credential_has_user" CHECK ("credential_id" IS NULL OR "user_id" IS NOT NULL);

