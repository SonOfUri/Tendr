-- When Tendr recognised a sponsorship's cost as its own unrecovered loss (sponsor = tendr). The
-- daily loss cap counts losses by this time (UTC day), not by when the sponsorship was made.
ALTER TABLE "gas_sponsorships" ADD COLUMN "loss_recognized_at" TIMESTAMP(3);

-- Losses recorded before this column existed: recognised when last updated.
UPDATE "gas_sponsorships" SET "loss_recognized_at" = "updated_at"
WHERE "sponsor" = 'tendr' AND "loss_recognized_at" IS NULL;

-- CreateIndex
CREATE INDEX "gas_sponsorships_livemode_loss_recognized_at_idx" ON "gas_sponsorships"("livemode", "loss_recognized_at");
