import type {
  LineItem,
  ThemeAssetObject,
  ThemeDocument,
  SessionStatus,
  PaymentStatus,
  RefundReason,
  HeldReason,
  SessionExpiredReason,
  NetworkFeeView,
  ExternalTxStatus,
  SponsorshipMethod,
  Sponsor,
  GasReservationState,
  FeeMode,
  PaymentLinkCreate,
  WebhookEventType,
} from './contracts.generated.js';

export type { LineItem, ThemeAssetObject };
export type * from './contracts.generated.js';
export type ThemeAssetKind = ThemeAssetObject['kind'];

/** A merchant payment link as `/v1/payment_links` returns it. */
export interface PaymentLinkObject {
  /** Null inherits the store default; an override credits this asset to the Tendr account. */
  settlement_asset: string | null;
  settlement_symbol: string | null;
  settlement_chain: string | null;
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
  theme_id: string | null;
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
  data: Array<{ id: string; label: string; description: string; document: ThemeDocument }>;
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
  /** Integrator contract payload: non-null JSON, at most 1 KB serialized. */
  hook_data?: Exclude<JsonValue, null>;
  /** One of the store's themes. A live session renders it only once published. */
  theme_id?: string;
  /** Cart lines for the order summary, at most 50. */
  line_items?: LineItem[];
  /** Seconds until the session expires (60 to 1800). */
  expires_in?: number;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export interface Page<T> {
  data: T[];
  has_more: boolean;
}
export interface PaginationQuery {
  limit?: number;
  starting_after?: string;
}
export type PaymentLinkCreateInput = Omit<PaymentLinkCreate, 'note'> & {
  note?: PaymentLinkCreate['note'];
};
export interface PaymentLinkListQuery extends PaginationQuery {
  status?: 'active' | 'inactive';
  include_archived?: boolean;
}
export type ThemeListQuery = PaginationQuery;
export interface ThemeObject {
  id: string;
  object: 'theme';
  name: string;
  is_default: boolean;
  version: number;
  status: 'draft' | 'published';
  draft: ThemeDocument;
  published: ThemeDocument | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  used_by_links: number;
}
export interface ThemeUpdate {
  name?: string;
  draft?: ThemeDocument;
}

/** Returned only by create. Save the complete URL, including its secret fragment. */
export interface CreatedCheckoutSession {
  id: string;
  client_secret: string;
  url: string;
  expires_at: string;
  status: 'PENDING_DEPOSIT';
}
export type MerchantRefundStatus = 'pending' | 'review' | 'sent' | 'cancelled';
/** Exactly one of payment or session is required. This requests a refund, not wallet approval. */
export type RefundCreateInput = {
  amount: string;
  currency?: string;
  reason?: string;
  external_ref: string;
} & ({ payment: string; session?: never } | { session: string; payment?: never });
export interface RefundObject {
  id: string;
  status: MerchantRefundStatus;
  amount_usd: string;
  refund_external_ref: string | null;
  payment_id: string;
  asset_id: string;
  asset_symbol: string | null;
  asset_decimals: number | null;
  /** Settlement token base units. */
  amount: string;
  review_reason: string | null;
  created: number;
}
export interface SessionRefund {
  id: string;
  reason: RefundReason;
  status: ExternalTxStatus;
  asset_id: string;
  asset_symbol: string | null;
  asset_decimals: number | null;
  amount: string | null;
  destination: string | null;
  destination_chain: string | null;
  needs_address: boolean;
  review_reason: string | null;
  refund_external_ref: string | null;
  merchant_status: MerchantRefundStatus | null;
  refund_tx_hash: string | null;
  created_at: string;
}
export interface SessionPayment {
  id: string;
  status: PaymentStatus;
  is_late: boolean;
  held_reason: HeldReason | null;
  amount_received: string | null;
  amount_out: string | null;
  amount_in_usd: string | null;
  overpaid_amount: string | null;
  refunded_amount: string | null;
  kept_small_overpayment: boolean;
  origin_tx_hash: string | null;
  sender_chain: string | null;
  network_fee: NetworkFeeView | null;
  settled_at: string | null;
  created_at: string;
  refunds: SessionRefund[];
}
/** Merchant read/expire response. It does not return the client secret from creation. */
export interface CheckoutSession {
  id: string;
  livemode: boolean;
  status: SessionStatus;
  expired_reason: SessionExpiredReason | null;
  amount: string;
  amount_currency: string;
  original_amount: string | null;
  original_currency: string | null;
  fx: { rate: string; source: string; as_of: string } | null;
  settlement_asset: string;
  settlement_asset_symbol: string | null;
  settlement_asset_decimals: number | null;
  settlement_chain: string;
  external_ref: string | null;
  customer_email: string | null;
  metadata: JsonValue;
  payer_note: string | null;
  success_url: string | null;
  cancel_url: string | null;
  fee_payer: 'merchant' | 'shopper';
  gas_payer: 'merchant' | 'shopper';
  delivery: 'hook' | 'webhook';
  hook_data: JsonValue;
  fee_bps: number;
  gas_max_usd: string | null;
  network_fee: NetworkFeeView | null;
  payment_link_id: string | null;
  theme_id: string | null;
  line_items: LineItem[] | null;
  /** This read URL has no secret fragment. Use the saved create URL to reopen checkout. */
  url: string;
  expires_at: string;
  created_at: string;
  payments: SessionPayment[];
  totals: { settled_amount_out: string; payment_count: number; refund_count: number };
}
export interface PingResponse {
  merchantId: string;
  livemode: boolean;
  principal: 'secret_key' | 'publishable_key';
  scopes?: string[];
}
export type HookCallStatus = 'pending' | 'submitted' | 'succeeded' | 'failed';
export interface HookCall {
  id: string;
  livemode: boolean;
  payment_id: string;
  session_id: string;
  chain: string;
  contract: string;
  hook_data: JsonValue;
  status: HookCallStatus;
  attempts: number;
  tx_hash: string | null;
  last_error: string | null;
  next_retry_at: string | null;
  retry_until: string;
  succeeded_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface HookCallListQuery extends PaginationQuery {
  payment?: string;
  session?: string;
  status?: HookCallStatus;
}
export interface HookCallPage {
  hook_calls: HookCall[];
  has_more: boolean;
  next_cursor: string | null;
}
export interface GasSponsorship {
  id: string;
  livemode: boolean;
  session_id: string | null;
  recovered_from_payment_id: string | null;
  hook_payment_id: string | null;
  chain: string;
  method: SponsorshipMethod;
  provider: string;
  sponsor: Sponsor;
  status: ExternalTxStatus;
  tx_hash: string | null;
  user_op_hash: string | null;
  fee_mode: FeeMode | null;
  fee_asset: string | null;
  fee_amount: string | null;
  estimate_usd: string | null;
  cost_usd: string | null;
  gas_used: string | null;
  reservation_state: GasReservationState | null;
  created_at: string;
  updated_at: string;
}
export interface GasSponsorshipListQuery extends PaginationQuery {
  payment?: string;
  session?: string;
  status?: ExternalTxStatus;
  month?: string;
}
export interface GasSponsorshipPage {
  gas_sponsorships: GasSponsorship[];
  has_more: boolean;
  next_cursor: string | null;
}
/** Verified envelope. Narrow individual data fields before using them to fulfill an order. */
export interface WebhookEvent {
  id: string;
  type: WebhookEventType | (string & Record<never, never>);
  created: number;
  livemode: boolean;
  data: Record<string, unknown>;
}
