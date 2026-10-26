// The 1Click (NEAR Intents swap API, v0) provider seam. Field names mirror the API's JSON
// verbatim (camelCase). The real client (http.ts) is the only place that maps wire JSON to these
// types; the simulated test-mode provider (simulated.ts) produces them directly.
//
// Unverified against live 1Click: these shapes come from the public docs. If live differs, fix the
// mapping in http.ts (`toQuoteResponse`, `toStatusResponse`, `toTokenInfo`), not the callers.

export type SwapType = 'EXACT_INPUT' | 'EXACT_OUTPUT';

export interface AppFee {
  /** NEAR account that receives the fee (intents balance). */
  recipient: string;
  /** Basis points. */
  fee: number;
}

export interface QuoteRequest {
  /** `true`: price only, no deposit address is allocated. */
  dry: boolean;
  swapType: SwapType;
  /** Basis points. */
  slippageTolerance: number;
  /** 1Click asset id, e.g. `nep141:eth.omft.near`. */
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  /** Base units, decimal string: the input for EXACT_INPUT, the output for EXACT_OUTPUT. */
  amount: string;
  refundTo: string;
  refundType: 'ORIGIN_CHAIN' | 'INTENTS';
  recipient: string;
  recipientType: 'INTENTS' | 'DESTINATION_CHAIN';
  /** ISO-8601. Deposits after it are refunded. */
  deadline: string;
  appFees?: AppFee[];
}

export interface Quote {
  /** Absent on dry quotes. */
  depositAddress?: string;
  /** Base units, decimal strings. */
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  minAmountIn?: string;
  /** ISO-8601. */
  deadline?: string;
  /** ISO-8601. */
  timeWhenInactive?: string;
}

export interface QuoteResponse {
  quote: Quote;
  correlationId: string;
}

export const ONECLICK_STATUSES = [
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;

export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

export interface TxHashRef {
  hash: string;
  explorerUrl?: string;
}

export interface SwapDetails {
  originChainTxHashes: TxHashRef[];
  destinationChainTxHashes: TxHashRef[];
  /** Base units, decimal strings. */
  amountIn?: string;
  amountOut?: string;
  depositedAmount?: string;
  refundedAmount?: string;
  refundReason?: string;
  /**
   * SIMULATED PROVIDER ONLY: the address the (simulated) deposit came from. Real 1Click status has
   * no such field; live code reads the sender from the origin-chain transaction instead.
   */
  senderAddress?: string;
}

export interface StatusResponse {
  status: OneClickStatus;
  swapDetails: SwapDetails;
}

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  priceUsd?: string;
}

export interface OneClickProvider {
  tokens(): Promise<TokenInfo[]>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  /** Throws OneClickError (status 404) for an unknown deposit address. */
  status(depositAddress: string): Promise<StatusResponse>;
  /** Tells 1Click about a deposit transaction so it is picked up sooner. */
  submitDeposit(txHash: string, depositAddress: string): Promise<void>;
}

/**
 * A 1Click call failed.
 * - `status`: the HTTP status, or null when no response arrived (timeout, network).
 * - `code`: the API's error code when it gives one, else `HTTP_<status>`, `TIMEOUT`, `NETWORK`
 *   or `BAD_RESPONSE`.
 */
/** Longest untrusted provider value carried into an error's message, details or logs (T3). */
export const UNTRUSTED_VALUE_MAX = 200;

/** An untrusted provider value, as text of at most UNTRUSTED_VALUE_MAX characters. */
export function truncateUntrusted(value: unknown, max = UNTRUSTED_VALUE_MAX): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OneClickError';
  }
}
