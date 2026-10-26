-- Return to sender (checkout Task 8). One return per payment and reason, so a repeated watcher
-- hook or the sweeper never queues the same return twice. `return_fee` is the estimated
-- cross-chain return fee deducted from the gross return (`amount` is what is sent back).
-- `review_reason` marks a return that needs a person before it can be drafted: `sanctions` (the
-- destination screened as sanctioned), `needs_swap_route` (the asset cannot reach the sender's
-- chain by a PoA withdrawal), `price_unavailable` or `no_sender`.
ALTER TABLE "refunds" ADD COLUMN "return_fee" DECIMAL(78,0),
ADD COLUMN "review_reason" TEXT;

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_return_fee_nonnegative"
  CHECK ("return_fee" IS NULL OR "return_fee" >= 0);

CREATE UNIQUE INDEX "refunds_payment_id_reason_key" ON "refunds"("payment_id", "reason");
