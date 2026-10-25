-- A draft whose first approval is being relayed to the account contract (`propose`) is claimed,
-- so a local draft cancel cannot race the relay.
ALTER TABLE "account_proposals" ADD COLUMN "relay_claimed_at" TIMESTAMP(3);
