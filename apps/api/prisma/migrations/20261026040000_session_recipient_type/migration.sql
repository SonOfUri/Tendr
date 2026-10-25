-- Sessions pin how their recipient is addressed and the merchant intents account (refund
-- fallback) at creation, so account rotation or payout-mode changes never re-route a session.
CREATE TYPE "recipient_type" AS ENUM ('INTENTS', 'DESTINATION_CHAIN');

ALTER TABLE "sessions"
  ADD COLUMN "recipient_type" "recipient_type" NOT NULL DEFAULT 'INTENTS',
  ADD COLUMN "intents_account" TEXT;

-- Quotes record a shopper-reported deposit transaction (no new quote while one is in flight).
ALTER TABLE "quotes"
  ADD COLUMN "deposit_tx_hash" TEXT,
  ADD COLUMN "deposit_tx_submitted_at" TIMESTAMP(3);
