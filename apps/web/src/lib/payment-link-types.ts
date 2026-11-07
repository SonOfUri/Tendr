// Merchant payment-link shapes. Types only, so dashboard client components can import them
// without pulling in the server-only reader in lib/payment-links.ts.
import type { PaymentLinkAvailability } from '@tendr/contracts';

/** Mirrors `PaymentLinkView` in `apps/api/src/payment-links/links.ts`. */
export interface PaymentLinkView {
  id: string;
  object: 'payment_link';
  livemode: boolean;
  title: string;
  description: string | null;
  slug: string;
  url: string;
  qr_url: string;
  amount_type: 'fixed' | 'open';
  amount: string | null;
  currency: string;
  min_amount: string | null;
  note: 'off' | 'optional';
  /** Null = the store's default. */
  fee_payer: 'merchant' | 'shopper' | null;
  /** Null = the store's default. */
  gas_payer: 'merchant' | 'shopper' | null;
  gas_max_usd: string | null;
  /** Null = the store's default theme. */
  theme_id: string | null;
  /** Null = the store's settlement token. The balance stays in the Intents wallet. */
  settlement_asset: string | null;
  settlement_symbol: string | null;
  settlement_chain: string | null;
  status: 'active' | 'inactive';
  archived: boolean;
  availability: PaymentLinkAvailability;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  total_paid: string;
  total_refunded: string;
  total_paid_usd: string;
  total_refunded_usd: string;
  created_at: string;
  updated_at: string;
}

/** `GET /v1/payment_links`: newest first, paged with `starting_after`. */
export interface PaymentLinkList {
  data: PaymentLinkView[];
  has_more: boolean;
}
