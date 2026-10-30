/** A merchant payment link as `/v1/payment_links` returns it. */
export interface PaymentLinkObject {
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
  status: 'active' | 'inactive';
  archived: boolean;
  availability:
    'available' | 'inactive' | 'archived' | 'expired' | 'used_up' | 'merchant_not_ready';
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

export interface PaymentLinkPage {
  data: PaymentLinkObject[];
  has_more: boolean;
}
