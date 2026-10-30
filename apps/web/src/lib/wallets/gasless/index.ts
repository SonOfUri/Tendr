// Gasless wallet payments (project 5a): the shopper signs, Tendr's relayer pays the gas. This file
// is the light, SDK-free part the page imports up front: the API's wire shapes, which method a
// connected wallet uses, the fee choice, and the checks every prepared payload must pass against
// the quote BEFORE the wallet is asked to sign. The per-family signers (./evm, ./solana, ./near,
// ./tron) are imported only by the family modules, which load on demand (../load.ts).
//
// Method order (spec §2.3): EVM eip3009 → permit → paymaster (EIP-5792, only when the wallet
// reports `paymasterService` for the chain) → native; Solana kora; NEAR meta_tx (wallets that
// sign delegate actions); Tron forwarder (exact-amount approve, then a TendrPayment). A wallet is
// never asked to delegate itself (EIP-7702).
import { keccak_256 } from '@noble/hashes/sha3';
import type { Token } from '@/lib/checkout/api';
import type { PayTarget } from '../index';
import { sameAddress } from '../match';

export const GASLESS_METHODS = [
  'eip3009',
  'permit',
  'paymaster',
  'kora',
  'meta_tx',
  'forwarder',
] as const;
export type GaslessMethod = (typeof GASLESS_METHODS)[number];
export type FeeMode = 'token' | 'native';

export const isGaslessMethod = (m: unknown): m is GaslessMethod =>
  typeof m === 'string' && (GASLESS_METHODS as readonly string[]).includes(m);

/** One way this wallet can pay without the chain's coin (`POST gasless/options`). */
export interface GaslessOption {
  method: GaslessMethod;
  paid_by: 'merchant' | 'shopper';
  /** Shopper-safe: `not_sponsored`, `shopper_choice`, `fee_unavailable`, … or null. */
  reason: string | null;
  /** When the shopper pays: how they may pay it. Empty when the merchant sponsors. */
  fee_modes: FeeMode[];
  token_fee: { amount: string; symbol: string; decimals: number; usd: string } | null;
  /** The method exists but this account cannot use it (e.g. `near_account_needs_balance`). */
  unavailable_reason?: string;
}

export interface GaslessOptions {
  chain: string;
  family: string | null;
  /** The chain's coin ("ETH", "SOL"…), for "You'll need {coin} for the network fee". */
  native_symbol: string | null;
  /** Tendr's gas-fee account on this chain (ruling T10-g); null when no option is offered. */
  fee_recipient?: string | null;
  options: GaslessOption[];
}

export interface ToSign {
  kind: string;
  typed_data: unknown;
}

/** What to sign for the current quote (`POST gasless/prepare`). */
export interface PreparePayload {
  quote_id: string;
  method: GaslessMethod;
  chain: string;
  chain_id: number | null;
  signer: string;
  deadline: string;
  amount: string;
  fee_amount: string;
  /** Tron: `approve` first, then `payment`. */
  step?: 'approve' | 'payment';
  to_sign: ToSign[];
  /** paymaster: the calls the smart wallet batches, and the quote's paymaster URL. */
  calls?: { to: string; value: string; data: string }[];
  paymaster_url?: string;
}

export interface SignedPart {
  message: Record<string, unknown>;
  signature: string;
}

export interface SubmitBody {
  quote_id: string;
  signatures?: Record<string, SignedPart>;
  transaction?: string;
  signed_delegate?: string;
  tron_approve?: { raw_data_hex: string; signature: string };
}

export type SubmissionStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface SubmitResponse {
  submission_id: string;
  status: SubmissionStatus;
  tx_hash: string | null;
  step?: 'approve' | 'payment';
}

export interface SubmissionView {
  id: string;
  quote_id: string | null;
  status: SubmissionStatus;
  tx_hash: string | null;
  step?: 'approve' | 'payment';
}

/** The shopper routes the gasless flow uses (lib/checkout/api.ts implements them). */
export interface GaslessApi {
  gaslessOptions(input: { origin_asset: string; wallet_address: string }): Promise<GaslessOptions>;
  gaslessPrepare(input: {
    quote_id: string;
    method?: GaslessMethod;
    fee_mode?: FeeMode;
  }): Promise<PreparePayload>;
  gaslessSubmit(body: SubmitBody): Promise<SubmitResponse>;
  gaslessSubmission(id: string): Promise<SubmissionView>;
}

// ---------------------------------------------------------------------------------------------
// What the wallet signs must be exactly the quote
// ---------------------------------------------------------------------------------------------

/** Everything a prepared payload must bind, taken from the quote the shopper is looking at. */
export interface GaslessExpectation {
  quoteId: string;
  method: GaslessMethod;
  target: PayTarget;
  /** The connected wallet (the quote's wallet_address). */
  wallet: string;
  depositAddress: string;
  /** The quote's `amount_in`. */
  amount: bigint;
  /** The quote's `fee_amount` (0 when the merchant sponsors). */
  fee: bigint;
  /** The quote's deadline (ISO). Nothing signed may outlive it. */
  deadline: string;
  /**
   * Test mode (ruling T10-f): every payload must carry the test markers (`@tendr/contracts`
   * gasless-test.ts) so nothing signed is usable on a real chain; live payloads must not.
   */
  livemode: boolean;
  /**
   * Tendr's gas-fee account for this chain (ruling T10-g), resolved by `resolveFeeRecipient`.
   * Every fee leg must go exactly here; null refuses any payload that names one.
   */
  feeRecipient: string | null;
}

/** A prepared payload does not match the quote: the wallet is never asked to sign it. */
export class GaslessMismatchError extends Error {
  constructor(readonly field: string) {
    super(`The payment to sign does not match your price (${field})`);
    this.name = 'GaslessMismatchError';
  }
}

export const mismatch = (field: string) => new GaslessMismatchError(field);

/** The payload's own signing window ran out (e.g. Solana's blockhash): prepare it again. */
export class GaslessExpiredError extends Error {
  constructor() {
    super('The payment to sign expired');
    this.name = 'GaslessExpiredError';
  }
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;

/** A base-unit decimal string (or a safe integer) as a bigint; anything else is a mismatch. */
export function uintOf(v: unknown, field: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== 'string' || !UINT.test(v)) throw mismatch(field);
  return BigInt(v);
}

/** The quote's deadline in whole seconds (what a signed deadline may be at most). */
export function deadlineSeconds(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw mismatch('deadline');
  return BigInt(Math.floor(ms / 1000));
}

/** The quote fields the fee is read from (what the page shows and what is signed). */
export interface QuoteFeeFields {
  fee_amount?: string | null;
  network_fee?: {
    method: string | null;
    fee_mode: FeeMode | null;
    paid_by?: 'merchant' | 'shopper';
    amount?: string | null;
  } | null;
}

/**
 * The one fee the shopper sends on top of `amount_in` (I1): the fee line, the pay button and the
 * signed fee leg all use it. A fee only exists when the shopper pays in the token, and then
 * `fee_amount` must equal the amount the fee line shows; anything else is refused.
 */
export function quoteFee(quote: QuoteFeeFields): bigint {
  const nf = quote.network_fee;
  const raw = quote.fee_amount ?? null;
  if (nf?.paid_by === 'shopper' && nf.fee_mode === 'token') {
    const fee = raw === null ? 0n : uintOf(raw, 'fee_amount');
    if (fee === 0n || nf.amount !== raw) throw mismatch('fee_amount');
    return fee;
  }
  if (raw !== null && uintOf(raw, 'fee_amount') !== 0n) throw mismatch('fee_amount');
  return 0n;
}

/**
 * The fee recipient to check payloads against (ruling T10-g): the API's `fee_recipient`, which
 * must equal the address pinned in the page's config (NEXT_PUBLIC_GAS_FEE_RECIPIENTS). Live
 * payments need a pin; test mode accepts the API's value when none is pinned. Null → no gasless.
 */
export function resolveFeeRecipient(
  api: string | null | undefined,
  pinned: string | undefined,
  family: string,
  livemode: boolean,
): string | null {
  if (!api) return null;
  if (pinned === undefined) return livemode ? null : api;
  const same = family === 'evm' ? api.toLowerCase() === pinned.toLowerCase() : api === pinned;
  return same ? api : null;
}

/** The gasless expectation for a quote, or null when the quote is not a gasless one. */
export function expectationFor(
  quote: QuoteFeeFields & {
    id: string;
    deposit_address: string;
    amount_in: string;
    deadline: string;
  },
  target: PayTarget,
  wallet: string,
  o: { livemode: boolean; feeRecipient: string | null },
): GaslessExpectation | null {
  const method = gaslessMethodOf(quote);
  if (!method) return null;
  return {
    quoteId: quote.id,
    method,
    target,
    wallet,
    depositAddress: quote.deposit_address,
    amount: uintOf(quote.amount_in, 'amount'),
    fee: quoteFee(quote),
    deadline: quote.deadline,
    livemode: o.livemode,
    feeRecipient: o.feeRecipient,
  };
}

/** The quote's gasless method, or null when the shopper's wallet sends normally. */
export function gaslessMethodOf(quote: {
  network_fee?: { method: string | null; fee_mode: FeeMode | null } | null;
}): GaslessMethod | null {
  const nf = quote.network_fee;
  if (!nf || nf.fee_mode === 'native' || !isGaslessMethod(nf.method)) return null;
  return nf.method;
}

/** A fee leg's recipient must be exactly Tendr's gas-fee account (EVM addresses without case). */
export function assertFeeRecipient(e: GaslessExpectation, to: unknown, field: string): void {
  const r = e.feeRecipient;
  const ok =
    typeof to === 'string' &&
    r !== null &&
    (e.target.family === 'evm' ? to.toLowerCase() === r.toLowerCase() : to === r);
  if (!ok) throw mismatch(field);
}

/** The deterministic nonce of a signed leg: keccak256("tendr:gasless:<leg>:<quote id>") (m6). */
export function gaslessNonce(quoteId: string, leg: 'payment' | 'fee' | 'tendr_payment'): string {
  const bytes = keccak_256(new TextEncoder().encode(`tendr:gasless:${leg}:${quoteId}`));
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fields every family's payload shares: same quote, method, chain, signer and amounts. */
export function assertPrepareMatches(p: PreparePayload, e: GaslessExpectation): void {
  if (!p || typeof p !== 'object') throw mismatch('payload');
  if (p.quote_id !== e.quoteId) throw mismatch('quote_id');
  if (p.method !== e.method) throw mismatch('method');
  if (p.chain !== e.target.blockchain) throw mismatch('chain');
  if (e.target.family === 'evm' && p.chain_id !== e.target.chainId) throw mismatch('chain_id');
  if (!sameAddress(e.target.family, p.signer, e.wallet)) throw mismatch('signer');
  if (uintOf(p.amount, 'amount') !== e.amount) throw mismatch('amount');
  if (uintOf(p.fee_amount, 'fee_amount') !== e.fee) throw mismatch('fee_amount');
  const deadline = Date.parse(p.deadline);
  if (!Number.isFinite(deadline) || deadline > Date.parse(e.deadline)) throw mismatch('deadline');
  if (!Array.isArray(p.to_sign)) throw mismatch('to_sign');
}

// ---------------------------------------------------------------------------------------------
// The wallet side
// ---------------------------------------------------------------------------------------------

/** What the wallet produced: a payload for `gasless/submit`, or calls it sent itself (EIP-5792). */
export type SignResult =
  | { kind: 'submit'; body: Omit<SubmitBody, 'quote_id'> }
  | { kind: 'wallet_sent'; txHash: string | null; state: 'sent' | 'uncertain' };

/** A connected wallet's gasless abilities (WalletAdapter.gasless). */
export interface GaslessSigner {
  /** The methods this wallet can sign for, in preference order (may be empty). */
  methods(): Promise<GaslessMethod[]>;
  /** The wallet's balance of the chain's coin in base units, or null when unknown. */
  nativeBalance(): Promise<bigint | null>;
  /**
   * Checks `p` against `e` (throws GaslessMismatchError before the wallet is touched), then asks
   * the wallet to sign.
   */
  sign(p: PreparePayload, e: GaslessExpectation): Promise<SignResult>;
}

/** The option the wallet uses: the first of its methods the API offers (and the account can use). */
export function pickOption(
  options: GaslessOption[],
  methods: GaslessMethod[],
): GaslessOption | null {
  for (const m of methods) {
    const o = options.find(
      (x) =>
        x.method === m &&
        !x.unavailable_reason &&
        (x.paid_by === 'merchant' || x.fee_modes.includes('token')),
    );
    if (o) return o;
  }
  return null;
}

/** Why a method the wallet could sign for is not offered to this account, if one is. */
export function unavailableReason(
  options: GaslessOption[],
  methods: GaslessMethod[],
): string | null {
  for (const m of methods) {
    const o = options.find((x) => x.method === m && x.unavailable_reason);
    if (o) return o.unavailable_reason!;
  }
  return null;
}

/** The shopper chooses token vs coin only when the shopper pays and both are possible. */
export function feeChoiceAvailable(option: GaslessOption | null): boolean {
  return (
    option !== null &&
    option.paid_by === 'shopper' &&
    option.fee_modes.includes('token') &&
    option.fee_modes.includes('native')
  );
}

/** A decimal string as an exact rational n / 10^18 (null when it is not a plain decimal). */
function fixed18(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  const m = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

/**
 * The network fee in the chain's coin (base units, rounded up) from its USD estimate and the
 * coin's token-list price; null when either is unknown. The token option's USD fee includes the
 * fee leg and the margin, so this errs high: the coin is preselected only with room to spare.
 */
export function nativeFeeUnits(usd: string | null | undefined, coin: Token | null): bigint | null {
  if (!coin) return null;
  const u = fixed18(usd ?? null);
  const price = fixed18(coin.price_usd);
  if (u === null || price === null || price === 0n) return null;
  const scale = 10n ** BigInt(coin.decimals);
  return (u * scale + price - 1n) / price;
}

/**
 * The fee choice's starting point: the token (always works), or the coin when the wallet already
 * holds at least twice the coin fee.
 */
export function defaultFeeMode(balance: bigint | null, nativeFee: bigint | null): FeeMode {
  if (balance === null || nativeFee === null || nativeFee <= 0n) return 'token';
  return balance >= 2n * nativeFee ? 'native' : 'token';
}
