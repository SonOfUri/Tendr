-- A historical session never blocks deleting the theme it named: only theme_id is cleared
-- (merchant_id is NOT NULL). Postgres 15+ column-list form; Prisma cannot express it, so
-- schema.prisma keeps `onDelete: Restrict` for this relation. Payment links stay RESTRICT.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_theme_id_merchant_id_fkey";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_theme_id_merchant_id_fkey" FOREIGN KEY ("theme_id", "merchant_id") REFERENCES "checkout_themes"("id", "merchant_id") ON DELETE SET NULL ("theme_id") ON UPDATE RESTRICT;
