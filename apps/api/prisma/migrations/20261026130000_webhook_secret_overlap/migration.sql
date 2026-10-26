-- Webhook secret rotation overlap (checkout Task 9): for 24 h after a rotation the replaced secret
-- also signs each send (a second `v1=` in Tendr-Signature). The old `secrets` row is deleted at the
-- next rotation. No FK: a back-pointer set only by `rotateEndpointSecret`.
ALTER TABLE "webhook_endpoints"
  ADD COLUMN "previous_secret_ref" TEXT,
  ADD COLUMN "previous_secret_expires_at" TIMESTAMP(3);
