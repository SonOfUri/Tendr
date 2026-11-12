CREATE TYPE "invoice_amount_currency" AS ENUM ('TOKEN', 'USD');

-- Do not reinterpret previously issued token amounts as dollars.
ALTER TABLE "invoices" ADD COLUMN "amount_currency" "invoice_amount_currency" NOT NULL DEFAULT 'TOKEN';
