-- Task 12 fix round 1: when a sweep attempt failed (a failed account and token back off 6 h
-- before they are planned again).

-- AlterTable
ALTER TABLE "fee_sweeps" ADD COLUMN     "failed_at" TIMESTAMP(3);
