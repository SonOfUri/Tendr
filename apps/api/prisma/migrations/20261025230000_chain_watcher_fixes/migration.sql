-- Task 12 fix round 1: the mailbox half of recovery-kit passkey registration (R28), proposals
-- first seen on chain whose creator is not a known person (I4), and the mirrored recovery-key
-- epoch used to verify kit signatures before any per-account counter is charged (I2).

-- AlterEnum
ALTER TYPE "email_token_purpose" ADD VALUE 'recovery_register';

-- AlterTable
ALTER TABLE "account_proposals" ALTER COLUMN "created_by_user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "merchant_accounts" ADD COLUMN     "recovery_key_epoch" BIGINT;
