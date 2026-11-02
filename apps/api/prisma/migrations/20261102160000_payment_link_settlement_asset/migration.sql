ALTER TABLE payment_links
  ADD COLUMN settlement_asset_id TEXT,
  ADD COLUMN settlement_asset_symbol TEXT,
  ADD COLUMN settlement_asset_chain TEXT,
  ADD CONSTRAINT payment_links_settlement_asset_complete CHECK (
    (settlement_asset_id IS NULL AND settlement_asset_symbol IS NULL AND settlement_asset_chain IS NULL)
    OR
    (settlement_asset_id IS NOT NULL AND settlement_asset_symbol IS NOT NULL AND settlement_asset_chain IS NOT NULL)
  );
