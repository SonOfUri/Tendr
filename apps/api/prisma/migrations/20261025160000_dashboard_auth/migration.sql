-- Dashboard auth (Task 9): passkey revocation and server-issued WebAuthn ceremony challenges.

-- CreateEnum
CREATE TYPE "webauthn_challenge_purpose" AS ENUM ('registration', 'authentication');

-- AlterTable
ALTER TABLE "webauthn_credentials" ADD COLUMN "revoked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "webauthn_challenges" (
    "id" TEXT NOT NULL,
    "purpose" "webauthn_challenge_purpose" NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_challenges_challenge_hash_key" ON "webauthn_challenges"("challenge_hash");

-- CreateIndex
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "webauthn_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A registration challenge is bound to the person registering; a login challenge to nobody.
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_matches_purpose"
  CHECK (("purpose" = 'registration') = ("user_id" IS NOT NULL));
