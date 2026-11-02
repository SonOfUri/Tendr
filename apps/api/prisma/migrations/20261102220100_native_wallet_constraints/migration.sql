ALTER TABLE webauthn_challenges DROP CONSTRAINT webauthn_challenges_user_matches_purpose;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_user_matches_purpose CHECK (
  (purpose::text IN ('registration', 'native_wallet_registration') AND user_id IS NOT NULL)
  OR (purpose = 'authentication' AND user_id IS NULL)
  OR purpose = 'recovery_session'
);
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_native_scope CHECK (
  (purpose::text = 'native_wallet_registration' AND merchant_id IS NOT NULL AND livemode IS TRUE)
  OR (purpose::text <> 'native_wallet_registration' AND merchant_id IS NULL AND livemode IS NULL)
);
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_merchant_id_fkey
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE merchant_accounts ADD CONSTRAINT merchant_accounts_native_config CHECK (
  kind <> 'native_intents' OR (threshold = 1 AND contract_code_hash IS NULL AND created_tx IS NULL)
);
ALTER TABLE native_payouts ADD CONSTRAINT native_payouts_positive_amount CHECK (
  amount ~ '^[1-9][0-9]{0,38}$' AND amount::numeric <= 340282366920938463463374607431768211455
);
