-- A recovery-session challenge (R28) names the person it may open a session for, or nobody (an
-- email that is not a recoverable member: such a challenge can never verify).
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_user_matches_purpose";
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_matches_purpose" CHECK (
  ("purpose" = 'registration' AND "user_id" IS NOT NULL)
  OR ("purpose" = 'authentication' AND "user_id" IS NULL)
  OR "purpose" = 'recovery_session'
);
