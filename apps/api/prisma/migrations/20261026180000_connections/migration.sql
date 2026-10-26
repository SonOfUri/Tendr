-- WooCommerce plugin, Task 1: connections (sites linked to a store through Connect) and their
-- single-use authorization codes. Connection keys are ordinary api_keys rows with connection_id
-- set (ruling W1); a connection's webhook endpoints and the sessions its keys create carry it too.
-- Every reference to a connection from a merchant-owned row is composite
-- (connection_id, merchant_id), so a row can only point at a connection of its own merchant.

-- CreateEnum
CREATE TYPE "connection_platform" AS ENUM ('woocommerce');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "connection_id" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "connection_id" TEXT;

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "connection_id" TEXT;

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "platform" "connection_platform" NOT NULL,
    "site_url" TEXT NOT NULL,
    "site_origin" TEXT NOT NULL,
    "connected_by_user_id" TEXT NOT NULL,
    "added_domain" TEXT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connect_auth_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "return_url" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connect_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connections_merchant_id_idx" ON "connections"("merchant_id");

-- CreateIndex
CREATE INDEX "connections_connected_by_user_id_idx" ON "connections"("connected_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connections_id_merchant_id_key" ON "connections"("id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "connect_auth_codes_code_hash_key" ON "connect_auth_codes"("code_hash");

-- CreateIndex
CREATE INDEX "connect_auth_codes_connection_id_idx" ON "connect_auth_codes"("connection_id");

-- CreateIndex
CREATE INDEX "api_keys_connection_id_idx" ON "api_keys"("connection_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_connection_id_idx" ON "webhook_endpoints"("connection_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_connection_id_merchant_id_fkey" FOREIGN KEY ("connection_id", "merchant_id") REFERENCES "connections"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_connection_id_merchant_id_fkey" FOREIGN KEY ("connection_id", "merchant_id") REFERENCES "connections"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_connection_id_merchant_id_fkey" FOREIGN KEY ("connection_id", "merchant_id") REFERENCES "connections"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "connect_auth_codes" ADD CONSTRAINT "connect_auth_codes_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A connection records only the domain it added itself: its own site origin.
ALTER TABLE "connections" ADD CONSTRAINT "connections_added_domain_is_origin"
  CHECK ("added_domain" IS NULL OR "added_domain" = "site_origin");

-- Only digests are stored: a sha256 hex code hash and an S256 (base64url, 43 chars) challenge.
ALTER TABLE "connect_auth_codes" ADD CONSTRAINT "connect_auth_codes_code_hash_hex"
  CHECK ("code_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "connect_auth_codes" ADD CONSTRAINT "connect_auth_codes_code_challenge_s256"
  CHECK ("code_challenge" ~ '^[A-Za-z0-9_-]{43}$');
