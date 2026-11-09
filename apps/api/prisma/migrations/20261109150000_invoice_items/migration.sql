-- Nullable for older invoices and API instances during the rolling deployment.
ALTER TABLE invoices ADD COLUMN items JSONB;
ALTER TABLE invoices ADD CONSTRAINT invoices_items_array CHECK (
  items IS NULL OR (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 50)
);
