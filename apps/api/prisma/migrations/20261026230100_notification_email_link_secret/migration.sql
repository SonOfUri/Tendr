-- Task 6 fix round 1 (ruling W16.3): the verify-link mail goes out after commit, from an event
-- handler. The raw token it carries is KeyVault-encrypted in `secrets` until sent, referenced
-- here, and deleted once the link is sent or the pending change ends. Never set without a pending
-- change.
ALTER TABLE "merchants" ADD COLUMN "notification_email_link_secret_ref" TEXT;

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_notification_email_link_secret_ref_fkey"
  FOREIGN KEY ("notification_email_link_secret_ref") REFERENCES "secrets"("id")
  ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_notification_email_link_secret_check" CHECK (
    "notification_email_link_secret_ref" IS NULL OR "notification_email_pending" IS NOT NULL
  );
