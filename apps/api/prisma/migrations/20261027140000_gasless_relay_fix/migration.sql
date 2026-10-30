-- Gasless relay fixes (project 5a, Task 5 fix round): the fee a relayed transaction actually moved
-- (revenue is booked from the receipt, not the quote), the receipt's logs, and a database guard
-- that no two in-flight relayer transactions share a (chain, sender, nonce).

-- AlterTable
ALTER TABLE "gas_sponsorships" ADD COLUMN     "fee_collected" DECIMAL(78,0);

-- AlterTable
ALTER TABLE "relayer_transactions" ADD COLUMN     "receipt_logs" JSONB;

-- One in-flight transaction per nonce: a sender that lost its Redis nonce lock fails here, before
-- broadcast, instead of replacing another submission's transaction in the mempool.
CREATE UNIQUE INDEX "relayer_transactions_in_flight_nonce_key"
  ON "relayer_transactions" ("chain", "from_address", "nonce")
  WHERE "status" IN ('pending', 'submitted');
