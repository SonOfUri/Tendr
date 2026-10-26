-- Return-address link (Ruling C20): the `refund_needs_address` email carries a single-use token
-- bound to one refund (`<refund id>.<32 random bytes>`). Only its sha256 is stored; it expires
-- after 7 days and is cleared when used (or replaced by a newer email's token).
ALTER TABLE "refunds" ADD COLUMN "address_token_hash" TEXT,
ADD COLUMN "address_token_expires_at" TIMESTAMP(3);
