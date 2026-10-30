-- Gasless Tron fix round (project 5a, Task 9): measured consumption of lent energy (the receiver's
-- EnergyUsed at delegation and before the reclaim), the provisional Tendr cost row recognised at
-- delegation time, the part of an approval's cost a payment carries, and the planned delegation
-- count.

-- AlterTable
ALTER TABLE "tron_approvals" ADD COLUMN     "cost_booked_sun" BIGINT,
ADD COLUMN     "planned_delegations" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "provisional_cost_id" TEXT;

-- AlterTable
ALTER TABLE "tron_delegations" ADD COLUMN     "energy_used_after" BIGINT,
ADD COLUMN     "energy_used_before" BIGINT;
