-- A provisioning attempt claims its merchant account (attempt id + lease), so a retried job and
-- an owner retry cannot both send the provisioning transaction or both activate the account.
ALTER TABLE "merchant_accounts" ADD COLUMN "provision_attempt_id" TEXT,
ADD COLUMN "provision_claimed_at" TIMESTAMP(3);
