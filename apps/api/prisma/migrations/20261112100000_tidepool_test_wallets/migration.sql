ALTER TABLE webauthn_challenges DROP CONSTRAINT webauthn_challenges_native_scope;
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_native_scope CHECK (
  (purpose::text = 'native_wallet_registration' AND merchant_id IS NOT NULL AND livemode IS NOT NULL)
  OR (purpose::text <> 'native_wallet_registration' AND merchant_id IS NULL AND livemode IS NULL)
);
-- Historical Test quotes belong to the simulator. New real-testnet quotes opt in explicitly.
ALTER TABLE quotes ADD COLUMN test_provider TEXT;
ALTER TABLE quotes ADD CONSTRAINT quotes_test_provider_valid CHECK (
  test_provider IS NULL OR (livemode = false AND test_provider IN ('simulated', 'tidepool'))
);
