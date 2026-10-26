-- WooCommerce plugin, Task 3 fix (ruling W9): a site re-connect re-points the old connection's
-- undelivered webhook deliveries to the new connection's endpoint. A row whose event the new
-- endpoint already has is marked `superseded` instead (never sent; no retry, no resend).
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_status_check";
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_status_check"
  CHECK ("status" IN ('pending', 'delivered', 'failed', 'superseded'));
