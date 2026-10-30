-- Checkout themes: documents, product images, line items, connection brand.
-- No theme rows exist in any environment worth keeping (seed rows are rewritten), so the old
-- columns drop without backfill. References are cleared first so the rows can be deleted.
UPDATE "sessions" SET "theme_id" = NULL WHERE "theme_id" IS NOT NULL;
UPDATE "payment_links" SET "theme_id" = NULL WHERE "theme_id" IS NOT NULL;
DELETE FROM "theme_assets";
DELETE FROM "checkout_themes";

-- CreateEnum
CREATE TYPE "product_image_status" AS ENUM ('pending', 'ok', 'failed');

-- AlterTable
ALTER TABLE "checkout_themes"
    DROP COLUMN "display_name",
    DROP COLUMN "logo_url",
    DROP COLUMN "accent",
    DROP COLUMN "background",
    DROP COLUMN "text",
    DROP COLUMN "mode",
    DROP COLUMN "font",
    DROP COLUMN "corner_radius",
    DROP COLUMN "layout",
    DROP COLUMN "blocks",
    DROP COLUMN "schema_version",
    DROP COLUMN "custom_css",
    DROP COLUMN "css_validation",
    DROP COLUMN "button_label",
    DROP COLUMN "success_message",
    DROP COLUMN "support_url",
    DROP COLUMN "terms_url",
    DROP COLUMN "token_preferences",
    ADD COLUMN "draft" JSONB NOT NULL,
    ADD COLUMN "published" JSONB,
    ADD COLUMN "published_at" TIMESTAMP(3),
    ADD COLUMN "published_css" TEXT,
    ADD COLUMN "draft_css" TEXT;

-- DropEnum
DROP TYPE "theme_mode";
DROP TYPE "theme_layout";

-- One default theme per merchant.
CREATE UNIQUE INDEX "checkout_themes_one_default_per_merchant" ON "checkout_themes"("merchant_id") WHERE "is_default" = true;

-- AlterTable
ALTER TABLE "theme_assets" ALTER COLUMN "theme_id" DROP NOT NULL,
    ADD COLUMN "key" TEXT NOT NULL;
CREATE UNIQUE INDEX "theme_assets_key_key" ON "theme_assets"("key");

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "url_hash" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "status" "product_image_status" NOT NULL,
    "key" TEXT,
    "url" TEXT,
    "fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "product_images_merchant_id_idx" ON "product_images"("merchant_id");
CREATE UNIQUE INDEX "product_images_merchant_id_url_hash_key" ON "product_images"("merchant_id", "url_hash");
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "line_items" JSONB;
ALTER TABLE "connections" ADD COLUMN "brand" JSONB, ADD COLUMN "brand_updated_at" TIMESTAMP(3);
