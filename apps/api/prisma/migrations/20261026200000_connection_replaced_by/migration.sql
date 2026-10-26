-- WooCommerce plugin, Task 3 fix (ruling W8): a site re-connect records which connection replaced
-- the old one, so webhooks for sessions made with the old connection's keys reach the live
-- successor's endpoints. Only the re-connect sets it; a disconnect, a dashboard removal or the
-- sweeper leaves it null (such events reach no bound endpoint).

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "replaced_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_replaced_by_id_merchant_id_fkey" FOREIGN KEY ("replaced_by_id", "merchant_id") REFERENCES "connections"("id", "merchant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
