-- AlterTable
ALTER TABLE "gas_sponsorships" ADD COLUMN     "unrecovered_at" TIMESTAMP(3),
ADD COLUMN     "unrecovered_usd" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "paymaster_token_hash" TEXT;

-- CreateIndex
CREATE INDEX "gas_sponsorships_livemode_unrecovered_at_idx" ON "gas_sponsorships"("livemode", "unrecovered_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_paymaster_token_hash_key" ON "quotes"("paymaster_token_hash");

