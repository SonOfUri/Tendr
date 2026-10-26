-- When the last poll of a deposit address completed: the expiry sweep only expires a session once
-- every watched address was polled after its expiry (without polling under another poll's lease).
ALTER TABLE "quotes" ADD COLUMN "watch_polled_at" TIMESTAMP(3);
