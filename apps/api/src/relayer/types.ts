// The gasless relayer's shared interface (project 5a, spec §2.3, §3). One implementation per chain
// family (EVM now; Solana, Tron and NEAR in later tasks), plus a simulated one per family for test
// mode. `relayerFor(family, livemode)` picks it.
import type { Quote, Session } from '@prisma/client';
import type { GasPayer, GaslessMethod } from '@tendr/contracts';
import type { TokenInfo } from '../checkout/oneclick/index.js';
import type { ShopperCtx } from '../checkout/quotes.js';

export type ChainFamily = 'evm' | 'solana' | 'tron' | 'near';

/** A relayed submission's state (`gas_sponsorships.status`). Never "paid": only detection is. */
export type SubmissionStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

/** The shopper's session, the token they pay with and their connected wallet. */
export interface GaslessContext {
  shopper: ShopperCtx;
  session: Session;
  origin: TokenInfo;
  /** As given by the shopper (format-checked for the origin chain). */
  walletAddress: string;
}

/** The above, for the session's current quote (made with `wallet_address` and a method). */
export interface QuoteContext extends GaslessContext {
  quote: Quote;
}

/** One way the connected wallet can pay without the chain's coin, with its fee. */
export interface GaslessOption {
  method: GaslessMethod;
  /** `merchant`: "Network fee: paid by {merchant}". `shopper`: the fee lines below. */
  paid_by: GasPayer;
  /** Why the shopper pays (shopper-safe: `not_sponsored`, `shopper_choice`, …); null otherwise. */
  reason: string | null;
  /** `token`: "Pay the fee in {token}"; `native`: "Pay the fee in {coin}". Empty when sponsored. */
  fee_modes: ('token' | 'native')[];
  /** The fee in the payment token, on top of the payment ("+0.08 USDC"); null when sponsored. */
  token_fee: { amount: string; symbol: string; decimals: number; usd: string } | null;
}

export interface GaslessOptions {
  chain: string;
  family: ChainFamily | null;
  /** The chain's coin (for "Pay the fee in {coin}" and "You'll need {coin} for the network fee"). */
  native_symbol: string | null;
  /** Best first. Empty: no gasless method for this wallet + chain + token. */
  options: GaslessOption[];
}

export interface PrepareInput {
  method?: GaslessMethod;
  fee_mode?: 'token' | 'native';
}

/** What the shopper signs. EVM: EIP-712 typed data, in signing order. */
export interface PreparePayload {
  quote_id: string;
  method: GaslessMethod;
  chain: string;
  chain_id: number | null;
  /** The only address whose signatures are accepted (the quote's `wallet_address`). */
  signer: string;
  /** The quote deadline: every signed deadline is at or before it. */
  deadline: string;
  /** Base units of the origin token: the payment, and the fee on top (0 when sponsored). */
  amount: string;
  fee_amount: string;
  to_sign: { kind: string; typed_data: unknown }[];
}

/** The shopper's signatures, keyed by `to_sign[].kind`, each with the message it signed. */
export interface SignedPayload {
  signatures: Record<string, { message: Record<string, unknown>; signature: string }>;
}

export interface SubmitResult {
  /** `gas_sponsorships.id` of the relayed submission. */
  submissionId: string;
  txHash?: string;
  status: SubmissionStatus;
}

export interface GaslessRelayer {
  readonly family: ChainFamily;
  /** The gasless methods (with fee lines) for the wallet + token; [] when there is none. */
  options(c: GaslessContext): Promise<GaslessOption[]>;
  /** The messages to sign for the current quote. */
  prepare(q: QuoteContext, input: PrepareInput): Promise<PreparePayload>;
  /**
   * Checks every signed field against the quote, then relays. Refuses (no gas spent) with 409
   * GASLESS_PAYLOAD_MISMATCH, QUOTE_EXPIRED, GASLESS_NOT_AVAILABLE or SPONSORSHIP_RELEASED, and
   * 429 RATE_LIMITED.
   */
  submit(q: QuoteContext, signed: SignedPayload): Promise<SubmitResult>;
  status(submissionId: string): Promise<SubmissionStatus>;
}
