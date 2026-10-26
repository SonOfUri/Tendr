-- WooCommerce plugin, Task 6 (spec §3, §8): the store's notification email and the "You got paid"
-- switch. A new address is only `notification_email_pending` until the single-use link mailed to
-- it is used (sha256 of the token stored, 24 h); a new request replaces the token.
ALTER TABLE "merchants"
  ADD COLUMN "notification_email" TEXT,
  ADD COLUMN "notification_email_pending" TEXT,
  ADD COLUMN "notification_email_token_hash" TEXT,
  ADD COLUMN "notification_email_token_expires_at" TIMESTAMP(3),
  ADD COLUMN "notification_email_request" JSONB,
  ADD COLUMN "payment_emails_enabled" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "merchants_notification_email_token_hash_key"
  ON "merchants"("notification_email_token_hash");

-- Addresses are stored lower-cased; a pending change carries its token, expiry and request.
ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_notification_email_check" CHECK (
    ("notification_email" IS NULL OR "notification_email" = lower("notification_email"))
    AND (
      "notification_email_pending" IS NULL OR
      "notification_email_pending" = lower("notification_email_pending")
    )
    AND (
      (
        "notification_email_pending" IS NULL AND "notification_email_token_hash" IS NULL
        AND "notification_email_token_expires_at" IS NULL AND "notification_email_request" IS NULL
      ) OR (
        "notification_email_pending" IS NOT NULL
        AND "notification_email_token_hash" ~ '^[0-9a-f]{64}$'
        AND "notification_email_token_expires_at" IS NOT NULL
        AND "notification_email_request" IS NOT NULL
      )
    )
  );

-- Event notices: one per (event, template, recipient), so two notices of the same event (e.g. a
-- signer email and a store email) never suppress each other.
DROP INDEX "event_notices_event_id_recipient_key";
CREATE UNIQUE INDEX "event_notices_event_id_template_recipient_key"
  ON "event_notices"("event_id", "template", "recipient");
