-- Integrator hooks fix round 1: the OP-stack L1 data fee of a relayer transaction's receipt
-- (base, op), counted in a hook call's cost.

-- AlterTable
ALTER TABLE "relayer_transactions" ADD COLUMN     "l1_fee" DECIMAL(78,0);
