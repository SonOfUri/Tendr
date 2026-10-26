-- Sessions are looked up by the connection that created them (webhook delivery isolation,
-- the Connected sites view).

-- CreateIndex
CREATE INDEX "sessions_connection_id_idx" ON "sessions"("connection_id");
