-- R35: set while a storage top-up of the account is blocked (the funding daily cap); the
-- dashboard shows a warning while it is set. Cleared once the account has enough free balance.
ALTER TABLE "merchant_accounts" ADD COLUMN "storage_low_at" TIMESTAMP(3);

-- I3: an expired proposal still holds its creator's pending slot on chain until someone calls
-- `execute` on it. Set once that call settled it (or the chain already had it finished).
ALTER TABLE "account_proposals" ADD COLUMN "expiry_settled_at" TIMESTAMP(3);
