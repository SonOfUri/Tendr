-- Shopper quotes: how refunds are routed, and the USD value of amount_out (for fee lines).
CREATE TYPE "quote_refund_type" AS ENUM ('ORIGIN_CHAIN', 'INTENTS');

ALTER TABLE "quotes"
  ADD COLUMN "amount_out_usd" DECIMAL(18,6),
  ADD COLUMN "refund_type" "quote_refund_type";
