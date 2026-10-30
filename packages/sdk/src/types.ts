import type { LineItem, ThemeAssetObject, ThemeObject } from '@tendr/contracts';

export type { LineItem, ThemeAssetObject, ThemeObject };
export type ThemeAssetKind = ThemeAssetObject['kind'];

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

export interface ThemePage {
  data: ThemeObject[];
  has_more: boolean;
}

export interface ThemeDeleted {
  id: string;
  object: 'theme';
  deleted: true;
}

export interface ThemePresetList {
  data: Array<{ id: string; label: string; description: string; document: unknown }>;
}

export interface ThemeValidation {
  valid: boolean;
  /** `path` is dotted ("blocks.2.html", "custom_css"); CSS problems start with "Line N:". */
  problems: Array<{ path: string; message: string }>;
}

export interface ThemePreviewLink {
  url: string;
  expires_at: string;
}

/** The body of `POST /v1/checkout/sessions`. */
export interface SessionCreateInput {
  /** A decimal string like "25.10". */
  amount: string;
  amount_currency: string;
  external_ref: string;
  success_url: string;
  cancel_url: string;
  customer_email?: string;
  metadata?: Record<string, string>;
  fee_payer?: 'merchant' | 'shopper';
  gas_payer?: 'merchant' | 'shopper';
  payment_link_id?: string;
  /** One of the store's themes. A live session renders it only once published. */
  theme_id?: string;
  /** Cart lines for the order summary, at most 50. */
  line_items?: LineItem[];
  /** Seconds until the session expires (60 to 1800). */
  expires_in?: number;
}
