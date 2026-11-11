CREATE TABLE "login_recovery_codes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "code_hash" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3)
);
CREATE INDEX "login_recovery_codes_user_id_idx" ON "login_recovery_codes"("user_id");
CREATE TABLE "login_recovery_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "challenge_hash" TEXT,
  "challenge_expires_at" TIMESTAMP(3),
  "code_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "login_recovery_requests_user_id_idx" ON "login_recovery_requests"("user_id");
