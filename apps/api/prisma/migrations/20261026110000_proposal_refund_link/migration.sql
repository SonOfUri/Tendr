-- The return-to-sender refund a system-drafted `refund` proposal was created for (checkout
-- Task 8). An exact link that survives the refund's own `proposal_id` being cleared (cancel /
-- expiry review), so a late execution or an on-chain revival finds exactly its refund. No FK:
-- refunds already reference account_proposals, and this is a back-pointer set once at draft time.
ALTER TABLE "account_proposals" ADD COLUMN "refund_id" TEXT;

CREATE INDEX "account_proposals_refund_id_idx" ON "account_proposals"("refund_id");
