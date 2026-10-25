-- Sanctions-screening retry state for SCREENING_PENDING payments.
ALTER TABLE "payments"
  ADD COLUMN "screening_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "screening_next_at" TIMESTAMP(3),
  ADD COLUMN "screening_unresolved_at" TIMESTAMP(3);
