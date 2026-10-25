-- Dashboard auth hardening (Task 9 review).

-- When the session last proved a passkey (passkey login, first-passkey registration, step-up).
-- Sensitive actions require it to be at most 10 minutes old.
ALTER TABLE "dashboard_sessions" ADD COLUMN "passkey_verified_at" TIMESTAMP(3);

-- `none` attestation lets a client submit any public key, including someone else's on-chain
-- signer key. An active public key may belong to one credential only. (Not expressible in
-- Prisma: partial unique index, maintained here.)
CREATE UNIQUE INDEX "webauthn_credentials_active_public_key_key"
  ON "webauthn_credentials" ("public_key") WHERE "revoked_at" IS NULL;
