-- Merchant dashboard review queue (checkout Task 10).
--
-- The typed legal-clearance acknowledgement for a held (sanctions) payment, recorded on the
-- payment: when and by whom (a `users` id; no FK — a historical record that must survive the
-- person leaving the store). Required before a held payment's funds can be returned.
ALTER TABLE "payments"
  ADD COLUMN "legal_ack_at" TIMESTAMP(3),
  ADD COLUMN "legal_ack_by_user_id" TEXT;

-- Signer notice emails sent for an event (payment.held, payment.screening_unresolved,
-- refund.needs_review): one row per (event, recipient), claimed before the send, so a replayed
-- outbox job never mails the same person twice for the same event. Infrastructure only.
CREATE TABLE "event_notices" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "template" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_notices_event_id_recipient_key" ON "event_notices"("event_id", "recipient");
