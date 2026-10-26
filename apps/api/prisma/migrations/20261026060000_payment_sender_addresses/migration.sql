-- Every sender of a deposit (a Bitcoin deposit may spend inputs of several addresses); each is
-- screened. `sender_address` stays the first (primary) one.
ALTER TABLE "payments" ADD COLUMN "sender_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
