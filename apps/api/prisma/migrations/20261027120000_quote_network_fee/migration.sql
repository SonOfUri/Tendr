-- Gasless payments (project 5a, spec §2.5, §2.6, §8.1): each quote records who pays its network
-- fee, how, the quoted amount, the appFees basis points that collect a merchant-sponsored fee (and
-- the integrator hook estimate) from the merchant's proceeds, and its budget reservation.

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "gas_sponsorship_id" TEXT,
ADD COLUMN     "hook_fee_usd" DECIMAL(18,6),
ADD COLUMN     "network_fee_amount" DECIMAL(78,0),
ADD COLUMN     "network_fee_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "network_fee_method" "sponsorship_method",
ADD COLUMN     "network_fee_mode" "fee_mode",
ADD COLUMN     "network_fee_paid_by" "resolved_gas_sponsor",
ADD COLUMN     "network_fee_reason" TEXT,
ADD COLUMN     "network_fee_usd" DECIMAL(18,6);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_network_fee_check" CHECK (
    "network_fee_bps" >= 0 AND "network_fee_bps" < 10000
    AND ("network_fee_usd" IS NULL OR "network_fee_usd" >= 0)
    AND ("network_fee_amount" IS NULL OR "network_fee_amount" >= 0)
    AND ("hook_fee_usd" IS NULL OR "hook_fee_usd" >= 0)
  );

-- CreateIndex
CREATE UNIQUE INDEX "gas_sponsorships_id_merchant_id_livemode_key" ON "gas_sponsorships"("id", "merchant_id", "livemode");

-- CreateIndex
CREATE INDEX "quotes_gas_sponsorship_id_idx" ON "quotes"("gas_sponsorship_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_gas_sponsorship_id_merchant_id_livemode_fkey" FOREIGN KEY ("gas_sponsorship_id", "merchant_id", "livemode") REFERENCES "gas_sponsorships"("id", "merchant_id", "livemode") ON DELETE RESTRICT ON UPDATE RESTRICT;
