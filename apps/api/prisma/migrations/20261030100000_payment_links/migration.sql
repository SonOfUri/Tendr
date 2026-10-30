-- Payment links: description, open-amount minimum, note mode, fee payer, archive; payer note on sessions.

CREATE TYPE "payment_link_note_mode" AS ENUM ('off', 'optional');

ALTER TABLE "payment_links"
  DROP COLUMN "dest_asset",
  DROP COLUMN "dest_chain",
  ADD COLUMN "description" TEXT,
  ADD COLUMN "min_amount" DECIMAL(38,18),
  ADD COLUMN "note_mode" "payment_link_note_mode" NOT NULL DEFAULT 'optional',
  ADD COLUMN "fee_payer" "fee_payer",
  ADD COLUMN "archived_at" TIMESTAMP(3);

ALTER TABLE "sessions" ADD COLUMN "payer_note" VARCHAR(280);
