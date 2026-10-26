// The shopper checkout's API client: the `/v1/checkout/client/*` routes, authenticated by the
// session client secret as `Authorization: Bearer <secret>`. The secret goes in that header only:
// never in a URL, a body, a cookie or web storage. Requests carry no cookies (`credentials:
// 'omit'`) and no referrer. Errors use the API's `{ error: { code, message, details? } }` envelope.

export class CheckoutApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CheckoutApiError';
  }
}

export interface MerchantDisplay {
  name: string;
  logo_url: string | null;
}

export interface FeeLine {
  kind: string;
  label: string;
  amount_usd: string;
}

export interface Quote {
  id: string;
  origin_asset: string;
  deposit_address: string;
  /** Exact base units to send. */
  amount_in: string;
  amount_in_usd: string | null;
  deadline: string;
  expired: boolean;
  refund: 'origin_chain' | 'store';
  refund_address: string | null;
  fee_lines: FeeLine[];
  small_overpay_notice: boolean;
  small_overpay_usd: number;
}

export interface SessionPayment {
  id: string;
  /** detected | converting | processing | underpaid | settled | refunding | refunded | held | late */
  state: string;
  amount_received: string | null;
  overpaid_amount: string | null;
  refunded_amount: string | null;
  kept_small_overpayment: boolean;
  origin_tx_hash: string | null;
  created_at: string;
}

export interface SessionRefund {
  id: string;
  payment_id: string;
  asset: string;
  amount: string;
  needs_address: boolean;
  /** Networks the return can go to (only while it needs an address). */
  chains?: string[];
  /** processing | sent | review */
  state: string;
}

export interface TopupOffer {
  payment_id: string;
  origin_asset: string;
  deposit_address: string;
  remaining_amount: string;
  deadline: string;
  message: string;
}

export interface SessionView {
  id: string;
  livemode: boolean;
  merchant: MerchantDisplay;
  /** Origins allowed to frame the page. */
  checkout_domains: string[];
  amount: string;
  amount_currency: string;
  settlement_asset: string;
  status: string;
  expires_at: string;
  fee_payer: 'merchant' | 'shopper';
  gas_payer: 'merchant' | 'shopper';
  success_url: string | null;
  cancel_url: string | null;
  quote: Quote | null;
  payments: SessionPayment[];
  refunds: SessionRefund[];
  needs_email: boolean;
  /** When a deposit was reported for this session (any quote, any tab), else null. */
  deposit_submitted_at?: string | null;
  topup: TopupOffer | null;
}

export interface Token {
  asset_id: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price_usd: string | number | null;
  popular: boolean;
}

export interface QuoteInput {
  origin_asset: string;
  refund_address?: string;
  refund_chain?: string;
}

export interface RefundAddressInput {
  refund_id?: string;
  address: string;
  chain: string;
}

export interface RefundAddressResult {
  refund_id: string;
  status: string;
}

export type SimulateScenario = 'exact' | 'underpay' | 'overpay' | 'late' | 'failed' | 'topup';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function request<T>(
  fetchFn: FetchFn,
  url: string,
  init: { method: 'GET' | 'POST'; authorization?: string; json?: unknown },
): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (init.authorization) headers.set('authorization', init.authorization);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new CheckoutApiError(0, 'NETWORK_ERROR', 'Could not reach Tendr');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new CheckoutApiError(
      res.status,
      e?.code ?? 'HTTP_ERROR',
      e?.message ?? `Request failed (${res.status})`,
      e?.details,
    );
  }
  return body as T;
}

export interface CheckoutClient {
  session(): Promise<SessionView>;
  tokens(): Promise<{ tokens: Token[] }>;
  quote(input: QuoteInput): Promise<Quote>;
  /** Reports the shopper's deposit transaction (the connected-wallet flow). */
  deposit(txHash: string, quoteId: string): Promise<{ submitted: boolean }>;
  email(email: string): Promise<{ ok: boolean }>;
  refundAddress(input: RefundAddressInput): Promise<RefundAddressResult>;
  /** Test mode only. */
  simulate(scenario: SimulateScenario): Promise<unknown>;
}

export function createCheckoutClient(opts: {
  baseUrl: string;
  secret: string;
  fetchFn?: FetchFn;
}): CheckoutClient {
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/v1/checkout/client/`;
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const authorization = `Bearer ${opts.secret}`;
  const get = <T>(path: string) =>
    request<T>(fetchFn, base + path, { method: 'GET', authorization });
  const post = <T>(path: string, json: unknown) =>
    request<T>(fetchFn, base + path, { method: 'POST', authorization, json });
  return {
    session: () => get('session'),
    tokens: () => get('tokens'),
    quote: (input) => post('quote', input),
    deposit: (txHash, quoteId) => post('deposit', { tx_hash: txHash, quote_id: quoteId }),
    email: (email) => post('email', { email }),
    refundAddress: (input) => post('refund-address', input),
    simulate: (scenario) => post('simulate', { scenario }),
  };
}

/** The emailed return-address link: the single-use token authenticates it (no client secret). */
export function submitRefundAddressByToken(
  opts: { baseUrl: string; fetchFn?: FetchFn },
  input: { token: string; address: string; chain: string },
): Promise<RefundAddressResult> {
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  return request(fetchFn, `${opts.baseUrl.replace(/\/+$/, '')}/v1/checkout/refund-address`, {
    method: 'POST',
    json: input,
  });
}
