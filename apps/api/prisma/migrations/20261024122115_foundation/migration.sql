-- CreateEnum
CREATE TYPE "merchant_kind" AS ENUM ('merchant', 'integrator');

-- CreateEnum
CREATE TYPE "merchant_status" AS ENUM ('active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "merchant_user_role" AS ENUM ('owner', 'admin', 'finance', 'viewer');

-- CreateEnum
CREATE TYPE "api_key_kind" AS ENUM ('secret', 'publishable');

-- CreateEnum
CREATE TYPE "account_key_kind" AS ENUM ('passkey', 'fn_call');

-- CreateEnum
CREATE TYPE "payout_mode" AS ENUM ('wallet', 'intents');

-- CreateEnum
CREATE TYPE "allowlist_status" AS ENUM ('pending', 'active', 'revoked');

-- CreateEnum
CREATE TYPE "payment_link_status" AS ENUM ('active', 'inactive', 'expired');

-- CreateEnum
CREATE TYPE "gas_sponsor" AS ENUM ('default', 'merchant', 'buyer');

-- CreateEnum
CREATE TYPE "resolved_gas_sponsor" AS ENUM ('merchant', 'buyer');

-- CreateEnum
CREATE TYPE "amount_mode" AS ENUM ('EXACT_IN', 'EXACT_OUT');

-- CreateEnum
CREATE TYPE "delivery" AS ENUM ('WEBHOOK', 'HOOK');

-- CreateEnum
CREATE TYPE "fee_payer" AS ENUM ('merchant', 'payer');

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('PENDING_DEPOSIT', 'PROCESSING', 'SETTLED', 'REFUNDED', 'EXPIRED', 'LATE_DEPOSIT');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('DETECTED', 'PROCESSING', 'SETTLED', 'REFUNDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "refund_reason" AS ENUM ('expired', 'late', 'underpaid', 'failed');

-- CreateEnum
CREATE TYPE "external_tx_status" AS ENUM ('pending', 'submitted', 'confirmed', 'failed');

-- CreateEnum
CREATE TYPE "sponsorship_method" AS ENUM ('eip3009', 'permit', 'paymaster', 'paymaster_verifying', 'paymaster_erc20', 'energy', 'fee_payer');

-- CreateEnum
CREATE TYPE "sponsor" AS ENUM ('merchant', 'tendr');

-- CreateEnum
CREATE TYPE "screening_decision" AS ENUM ('allow', 'block');

-- CreateEnum
CREATE TYPE "revenue_source" AS ENUM ('app_fee', 'spread');

-- CreateEnum
CREATE TYPE "theme_status" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "theme_mode" AS ENUM ('light', 'dark', 'auto');

-- CreateEnum
CREATE TYPE "theme_layout" AS ENUM ('modal', 'inline', 'page');

-- CreateEnum
CREATE TYPE "theme_asset_kind" AS ENUM ('logo', 'image', 'font');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "merchant_kind" NOT NULL DEFAULT 'merchant',
    "aup_accepted_at" TIMESTAMP(3),
    "status" "merchant_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_users" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "merchant_user_role" NOT NULL,
    "auth_provider" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "api_key_kind" NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "signing_secret_ref" TEXT,
    "signing_required" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "near_account_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "kind" "account_key_kind" NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_configs" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "dest_asset_id" TEXT NOT NULL,
    "dest_chain" TEXT NOT NULL,
    "payout_mode" "payout_mode" NOT NULL,
    "payout_address" TEXT,
    "near_account" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_allowlist" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "allowlist_status" NOT NULL DEFAULT 'pending',
    "active_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_allowlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "url" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gas_policies" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "per_payment_cap_usd" DECIMAL(18,6) NOT NULL,
    "monthly_budget_usd" DECIMAL(18,6) NOT NULL,
    "min_order_usd" DECIMAL(18,6) NOT NULL,
    "chains" TEXT[],
    "tokens" TEXT[],
    "first_time_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gas_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "theme_id" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(38,18),
    "amount_currency" TEXT NOT NULL,
    "open_amount" BOOLEAN NOT NULL DEFAULT false,
    "dest_asset" TEXT NOT NULL,
    "dest_chain" TEXT NOT NULL,
    "gas_sponsor" "gas_sponsor" NOT NULL DEFAULT 'default',
    "gas_max_usd" DECIMAL(18,6),
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "status" "payment_link_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "theme_id" TEXT,
    "payment_link_id" TEXT,
    "external_ref" TEXT,
    "amount_mode" "amount_mode" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "amount_currency" TEXT NOT NULL,
    "dest_asset" TEXT NOT NULL,
    "dest_chain" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "beneficiary" TEXT,
    "delivery" "delivery" NOT NULL,
    "hook_data" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "fee_bps" INTEGER NOT NULL,
    "fee_payer" "fee_payer" NOT NULL,
    "gas_sponsor" "resolved_gas_sponsor" NOT NULL,
    "gas_max_usd" DECIMAL(18,6),
    "status" "session_status" NOT NULL DEFAULT 'PENDING_DEPOSIT',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "client_secret_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "origin_asset_id" TEXT NOT NULL,
    "deposit_address" TEXT NOT NULL,
    "amount_in" DECIMAL(78,0) NOT NULL,
    "amount_out" DECIMAL(78,0) NOT NULL,
    "refund_to" TEXT NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "oneclick_quote_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "origin_tx_hash" TEXT,
    "amount_received" DECIMAL(78,0) NOT NULL,
    "settle_tx" TEXT,
    "payout_tx" TEXT,
    "fee_amount" DECIMAL(78,0),
    "network_fee" DECIMAL(78,0),
    "gas_sponsored" BOOLEAN NOT NULL DEFAULT false,
    "status" "payment_status" NOT NULL DEFAULT 'DETECTED',
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "payment_id" TEXT NOT NULL,
    "reason" "refund_reason" NOT NULL,
    "refund_tx_hash" TEXT,
    "status" "external_tx_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "session_id" TEXT,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status_code" INTEGER,
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hook_calls" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "target_contract" TEXT NOT NULL,
    "tx_hash" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" "external_tx_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hook_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gas_sponsorships" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "tx_hash" TEXT,
    "method" "sponsorship_method" NOT NULL,
    "provider" TEXT NOT NULL,
    "user_op_hash" TEXT,
    "sponsor" "sponsor" NOT NULL,
    "gas_used" DECIMAL(78,0),
    "cost_usd" DECIMAL(18,6),
    "recovered_from_payment_id" TEXT,
    "status" "external_tx_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gas_sponsorships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_results" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "session_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "risk_score" DECIMAL(5,2) NOT NULL,
    "decision" "screening_decision" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "livemode" BOOLEAN,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_plans" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "fee_bps" INTEGER NOT NULL,
    "default_fee_payer" "fee_payer" NOT NULL,
    "volume_tiers" JSONB NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_entries" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "payment_id" TEXT NOT NULL,
    "source" "revenue_source" NOT NULL,
    "asset_id" TEXT NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_themes" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "theme_status" NOT NULL DEFAULT 'draft',
    "display_name" TEXT NOT NULL,
    "logo_url" TEXT,
    "accent" TEXT NOT NULL,
    "background" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mode" "theme_mode" NOT NULL DEFAULT 'auto',
    "font" TEXT NOT NULL,
    "corner_radius" INTEGER NOT NULL,
    "layout" "theme_layout" NOT NULL,
    "blocks" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "custom_css" TEXT,
    "css_hash" TEXT,
    "css_validation" JSONB,
    "button_label" TEXT,
    "success_message" TEXT,
    "support_url" TEXT,
    "terms_url" TEXT,
    "token_preferences" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_assets" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "theme_id" TEXT NOT NULL,
    "kind" "theme_asset_kind" NOT NULL,
    "url" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "theme_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'in_progress',
    "locked_at" TIMESTAMP(3) NOT NULL,
    "response_code" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "kek" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_users_merchant_id_email_key" ON "merchant_users"("merchant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_merchant_id_idx" ON "api_keys"("merchant_id");

-- CreateIndex
CREATE INDEX "account_keys_merchant_id_idx" ON "account_keys"("merchant_id");

-- CreateIndex
CREATE INDEX "settlement_configs_merchant_id_idx" ON "settlement_configs"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_allowlist_merchant_id_livemode_chain_address_key" ON "payout_allowlist"("merchant_id", "livemode", "chain", "address");

-- CreateIndex
CREATE INDEX "webhook_endpoints_merchant_id_idx" ON "webhook_endpoints"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_id_merchant_id_livemode_key" ON "webhook_endpoints"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "gas_policies_merchant_id_idx" ON "gas_policies"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_id_merchant_id_livemode_key" ON "payment_links"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_merchant_id_livemode_slug_key" ON "payment_links"("merchant_id", "livemode", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_client_secret_hash_key" ON "sessions"("client_secret_hash");

-- CreateIndex
CREATE INDEX "sessions_status_expires_at_idx" ON "sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_id_merchant_id_livemode_key" ON "sessions"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_merchant_id_livemode_external_ref_key" ON "sessions"("merchant_id", "livemode", "external_ref");

-- CreateIndex
CREATE INDEX "quotes_merchant_id_idx" ON "quotes"("merchant_id");

-- CreateIndex
CREATE INDEX "quotes_session_id_idx" ON "quotes"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_id_session_id_merchant_id_livemode_key" ON "quotes"("id", "session_id", "merchant_id", "livemode");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_livemode_deposit_address_key" ON "quotes"("livemode", "deposit_address");

-- CreateIndex
CREATE INDEX "payments_merchant_id_idx" ON "payments"("merchant_id");

-- CreateIndex
CREATE INDEX "payments_session_id_idx" ON "payments"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_merchant_id_livemode_key" ON "payments"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "refunds_merchant_id_idx" ON "refunds"("merchant_id");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_idempotency_key_key" ON "webhook_deliveries"("idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_deliveries_merchant_id_idx" ON "webhook_deliveries"("merchant_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries"("endpoint_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "hook_calls_merchant_id_idx" ON "hook_calls"("merchant_id");

-- CreateIndex
CREATE INDEX "hook_calls_session_id_idx" ON "hook_calls"("session_id");

-- CreateIndex
CREATE INDEX "gas_sponsorships_merchant_id_idx" ON "gas_sponsorships"("merchant_id");

-- CreateIndex
CREATE INDEX "gas_sponsorships_session_id_idx" ON "gas_sponsorships"("session_id");

-- CreateIndex
CREATE INDEX "screening_results_merchant_id_idx" ON "screening_results"("merchant_id");

-- CreateIndex
CREATE INDEX "screening_results_session_id_idx" ON "screening_results"("session_id");

-- CreateIndex
CREATE INDEX "events_merchant_id_idx" ON "events"("merchant_id");

-- CreateIndex
CREATE INDEX "events_aggregate_type_aggregate_id_idx" ON "events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "events_created_at_idx" ON "events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_id_merchant_id_livemode_key" ON "events"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "fee_plans_merchant_id_idx" ON "fee_plans"("merchant_id");

-- CreateIndex
CREATE INDEX "revenue_entries_merchant_id_idx" ON "revenue_entries"("merchant_id");

-- CreateIndex
CREATE INDEX "revenue_entries_payment_id_idx" ON "revenue_entries"("payment_id");

-- CreateIndex
CREATE INDEX "checkout_themes_merchant_id_idx" ON "checkout_themes"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_themes_id_merchant_id_key" ON "checkout_themes"("id", "merchant_id");

-- CreateIndex
CREATE INDEX "theme_assets_merchant_id_idx" ON "theme_assets"("merchant_id");

-- CreateIndex
CREATE INDEX "theme_assets_theme_id_idx" ON "theme_assets"("theme_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_merchant_id_livemode_key_key" ON "idempotency_keys"("merchant_id", "livemode", "key");

-- CreateIndex
CREATE UNIQUE INDEX "event_outbox_event_id_key" ON "event_outbox"("event_id");

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_signing_secret_ref_fkey" FOREIGN KEY ("signing_secret_ref") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_configs" ADD CONSTRAINT "settlement_configs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_allowlist" ADD CONSTRAINT "payout_allowlist_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_secret_ref_fkey" FOREIGN KEY ("secret_ref") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gas_policies" ADD CONSTRAINT "gas_policies_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_theme_id_merchant_id_fkey" FOREIGN KEY ("theme_id", "merchant_id") REFERENCES "checkout_themes"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_theme_id_merchant_id_fkey" FOREIGN KEY ("theme_id", "merchant_id") REFERENCES "checkout_themes"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_payment_link_id_merchant_id_livemode_fkey" FOREIGN KEY ("payment_link_id", "merchant_id", "livemode") REFERENCES "payment_links"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("quote_id", "session_id", "merchant_id", "livemode") REFERENCES "quotes"("id", "session_id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_merchant_id_livemode_fkey" FOREIGN KEY ("payment_id", "merchant_id", "livemode") REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_merchant_id_livemode_fkey" FOREIGN KEY ("endpoint_id", "merchant_id", "livemode") REFERENCES "webhook_endpoints"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_merchant_id_livemode_fkey" FOREIGN KEY ("event_id", "merchant_id", "livemode") REFERENCES "events"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "hook_calls" ADD CONSTRAINT "hook_calls_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hook_calls" ADD CONSTRAINT "hook_calls_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "gas_sponsorships" ADD CONSTRAINT "gas_sponsorships_recovered_from_payment_id_merchant_id_liv_fkey" FOREIGN KEY ("recovered_from_payment_id", "merchant_id", "livemode") REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_session_id_merchant_id_livemode_fkey" FOREIGN KEY ("session_id", "merchant_id", "livemode") REFERENCES "sessions"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_payment_id_merchant_id_livemode_fkey" FOREIGN KEY ("payment_id", "merchant_id", "livemode") REFERENCES "payments"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "checkout_themes" ADD CONSTRAINT "checkout_themes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_assets" ADD CONSTRAINT "theme_assets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_assets" ADD CONSTRAINT "theme_assets_theme_id_merchant_id_fkey" FOREIGN KEY ("theme_id", "merchant_id") REFERENCES "checkout_themes"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- events is append-only: reject every UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events is append-only'; END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
