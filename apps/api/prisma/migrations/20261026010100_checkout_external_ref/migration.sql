-- An order reference (external_ref) is unique per merchant and mode only among sessions that are
-- open or paid: PENDING_DEPOSIT, PROCESSING, SCREENING_PENDING, SETTLED. An expired, late, held or
-- refunded order may get a new session. (Not expressible in Prisma: partial unique index,
-- maintained here. The full unique index was dropped in 20261026010000_checkout_core, whose new
-- session_status values must be committed before this predicate can name them.)
CREATE UNIQUE INDEX "sessions_active_external_ref_key"
  ON "sessions" ("merchant_id", "livemode", "external_ref")
  WHERE "status" IN ('PENDING_DEPOSIT', 'PROCESSING', 'SCREENING_PENDING', 'SETTLED');
