/**
 * MANUAL. Checks the checkout design's "Assumptions to verify early" against 1Click, NEAR Intents
 * and Chainalysis on MAINNET. It SPENDS REAL FUNDS (about 3.5 USD of a NEAR token plus a little
 * NEAR for gas and storage, capped at 5 USD). Never run by CI.
 *
 *   export VERIFY_FUNDER_ACCOUNT_ID=you.near VERIFY_FUNDER_PRIVATE_KEY=ed25519:...
 *   export ONECLICK_API_KEY=<1Click JWT> VERIFY_CHAINALYSIS_API_KEY=<key>
 *   npm run checkout:verify:mainnet --workspace=@tendr/api -- \
 *     --yes-i-understand-this-spends-mainnet-funds
 *   npm run checkout:verify:mainnet --workspace=@tendr/api -- \
 *     --yes-i-understand-this-spends-mainnet-funds --phase cleanup
 *
 * You supply a funded mainnet account (about 0.2 NEAR and 4 USDT on NEAR by default). It plays the
 * merchant: every payment's recipient (`recipientType INTENTS`) and `refundTo` (`refundType
 * INTENTS`) is your own account's intents balance, so what is delivered or refunded stays yours;
 * `--phase cleanup` withdraws those intents balances back to your account's wallet balance.
 *   VERIFY_FUNDER_ACCOUNT_ID    your mainnet account (sends the payments, receives them)
 *   VERIFY_FUNDER_PRIVATE_KEY   ed25519:<base58> full-access key of that account (read from the
 *                               environment only; never printed or written anywhere)
 *   ONECLICK_API_KEY            the 1Click JWT (sent as X-API-Key, as the API does); required
 *   ONECLICK_BASE_URL           default https://1click.chaindefuser.com
 *   VERIFY_CHAINALYSIS_API_KEY  a Chainalysis sanctions API key; required
 *   NEAR_RPC_URL_LIVE           default https://rpc.mainnet.near.org
 *   FEE_ACCOUNT_LIVE            the appFees recipient, default fees.tendr.near (or --fee-account)
 *
 * Output is PASS / FAIL / INFO (and INCONCLUSIVE for (1b)) per check; the run stops at the first
 * FAIL. The checks, in order:
 *   (4)  Chainalysis: `identifications` for a known sanctioned address, none for a clean one (free)
 *   (c)  INFO: the raw 1Click dry-quote body, parsed by the API's own client (oneclick/http.ts)
 *   --- spend plan, cap check, typed confirmation; nothing is spent before this ---
 *   (1)  EXACT_OUTPUT, overpaid by 25%: the recipient is credited exactly amount_out (no more, no
 *        less), found the way the watcher's verifier finds it (settlement tx receipts, NEP-245
 *        event); the excess reaches refundTo
 *   (a)  INFO: which account routes tx_status to the settlement tx, and its receipts and events
 *   (3)  the appFees share reaches the fee account's intents balance (a balance delta: run this
 *        only before live fees flow to that account)
 *   (5)  INFO: the raw 1Click status bodies; whether the origin tx (and so the sender) is present
 *   (b)  INFO: an extra deposit to (1)'s address AFTER it settled: depositedAmount before/after,
 *        whether the new origin hash is listed, and whether the extra was refunded or swapped
 *   (1b) underpay by half, then top up the same deposit address before the deadline. PASS only
 *        when INCOMPLETE_DEPOSIT was seen before the top-up and the accumulated deposit settled
 *        (then CHECKOUT_TOPUP_ENABLED=true is safe in live); INCONCLUSIVE when the underpay was
 *        never seen; FAIL when 1Click refunded instead of accumulating
 *   (2)  a deposit sent after the quote deadline: refunded or swapped (prints which)
 * Wallets inside a cross-origin iframe (assumption 4) are a manual checklist in the README.
 *
 * A first FAIL may be a script-shape error against the unverified 1Click wire format rather than a
 * product problem; read the printed response before drawing conclusions. After a FAIL, or at the
 * end, run `--phase cleanup` to withdraw your intents balances. The fee share is paid to the fee
 * account and is not recoverable unless that account is yours.
 */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { HttpOneClick, type FetchLike } from '../src/checkout/oneclick/http.js';
import type {
  QuoteRequest,
  QuoteResponse,
  StatusResponse,
} from '../src/checkout/oneclick/types.js';
import { matchingCredits, parseEventLog, type TxReceipt } from '../src/near/events.js';
import { functionCallAction } from '../src/near/tx.js';
import {
  NEAR,
  ScriptAccount,
  TGAS,
  UsageError,
  firstFailure,
  formatNear,
  parseFlags,
  parseSecretKey,
} from './lib/near-script.js';

export const CONFIRM_FLAG = 'yes-i-understand-this-spends-mainnet-funds';
/** What the operator types at the prompt to go ahead. */
export const CONFIRM_WORD = 'spend';
/** What the operator types to let cleanup withdraw. */
export const WITHDRAW_WORD = 'withdraw';
/** Hard cap on everything one run may spend or put at risk, in USD. */
export const MAX_SPEND_USD = 5;
/** The cap in micro-USD: every amount is integer micro-USD, never a float. */
export const MAX_SPEND_MICRO_USD = BigInt(MAX_SPEND_USD) * 1_000_000n;

const INTENTS = 'intents.near';
const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NEAR_USDT = 'nep141:usdt.tether-token.near';
const WNEAR = 'nep141:wrap.near';
/** OFAC-listed (Tornado Cash router); Chainalysis reports an identification for it. */
const SANCTIONED_ADDRESS = '0x8589427373D6D84E98730D7795D8f6f8731FDA16';
/** A public, unsanctioned address (vitalik.eth). */
const CLEAN_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const CHAINALYSIS_URL = 'https://public.chainalysis.com/api/v1/address/';
const SLIPPAGE_BPS = 100;
const QUOTE_TTL_MS = 12 * 60_000;
/** The late-deposit check's quote lives this long, then the deposit is sent after it. */
const LATE_QUOTE_TTL_MS = 5 * 60_000;
const LATE_SEND_AFTER_DEADLINE_MS = 90_000;
const SETTLE_TIMEOUT_MS = 25 * 60_000;
const POLL_MS = 10_000;
/** Margin on the swap value for price movement between the dry and real quotes, percent. */
const PRICE_MARGIN_PCT = 5n;
/** NEP-145 registration of a 1Click deposit address on the origin token, per payment. */
const STORAGE_DEPOSIT_NEAR = (125n * NEAR) / 100_000n; // 0.00125 NEAR
/** Most the script pays to register the funder on the destination token (cleanup needs it). */
export const DEST_STORAGE_MAX_YOCTO = (125n * NEAR) / 10_000n; // 0.0125 NEAR
/** New deposit addresses ((1), (1b), (2)); check (b) reuses (1)'s, already registered. */
const PAYMENTS = 3;
/** Check (b)'s extra deposit after settlement: this fraction of (1)'s amountIn. */
const EXTRA_DIVISOR = 10n;
const EXTRA_WAIT_MS = 15 * 60_000;
/** Gas for every transaction of a run and a cleanup (about 12 at a few Tgas each), rounded up. */
const GAS_NEAR = NEAR / 20n; // 0.05 NEAR

export type Phase = 'run' | 'cleanup';

export interface VerifyArgs {
  phase: Phase;
  originAsset: string;
  destAsset: string;
  /** Destination-asset smallest units each payment must deliver (EXACT_OUTPUT `amount`). */
  amountOut: string;
  feeAccount: string;
  feeBps: number;
  sanctionedAddress: string;
  cleanAddress: string;
  funderId: string;
  funderKey: string;
  rpcUrl: string;
  oneClickUrl: string;
  oneClickKey: string | undefined;
  chainalysisKey: string | undefined;
}

export const PLAN_TEXT = [
  'This script spends MAINNET funds from the account you supply: three 1Click payments of about',
  '1 USD each (one overpaid by 25%, then topped up by 10% after it settles), NEAR for gas and',
  `storage, all capped at ${MAX_SPEND_USD} USD in total.`,
  'The exact plan is printed, and you must type a confirmation, before anything is spent.',
].join('\n');

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Parses argv and env. Throws UsageError (a refusal) unless every safety requirement is explicit. */
export function parseVerifyArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): VerifyArgs {
  const flags = parseFlags(argv, {
    [CONFIRM_FLAG]: 'bool',
    phase: 'value',
    'origin-asset': 'value',
    'destination-asset': 'value',
    amount: 'value',
    'fee-account': 'value',
    'fee-bps': 'value',
    'sanctioned-address': 'value',
    'clean-address': 'value',
  });
  if (!flags.has(CONFIRM_FLAG)) {
    throw new UsageError(`refusing to run: pass --${CONFIRM_FLAG} to confirm.\n${PLAN_TEXT}`);
  }
  const value = (name: string): string | undefined => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const phase = value('phase') ?? 'run';
  if (phase !== 'run' && phase !== 'cleanup') {
    throw new UsageError(`--phase must be "run" or "cleanup", got "${phase}"`);
  }

  const funderId = env.VERIFY_FUNDER_ACCOUNT_ID;
  const funderKey = env.VERIFY_FUNDER_PRIVATE_KEY;
  if (!funderId || !funderKey) {
    throw new UsageError(
      'VERIFY_FUNDER_ACCOUNT_ID and VERIFY_FUNDER_PRIVATE_KEY (ed25519:<base58>) must be set: a funded mainnet account of yours',
    );
  }
  if (funderId.endsWith('.testnet')) {
    throw new UsageError(`${funderId} is a testnet account; this script is for mainnet`);
  }
  // Refuse a malformed key before anything else runs. The error never contains the key.
  parseSecretKey(funderKey);

  const rpcUrl = env.NEAR_RPC_URL_LIVE || 'https://rpc.mainnet.near.org';
  if (/testnet/i.test(rpcUrl))
    throw new UsageError(`NEAR_RPC_URL_LIVE (${rpcUrl}) looks like testnet`);
  const oneClickUrl = env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com';
  if (/testnet/i.test(oneClickUrl)) {
    throw new UsageError(`ONECLICK_BASE_URL (${oneClickUrl}) looks like testnet`);
  }
  const oneClickKey = env.ONECLICK_API_KEY || undefined;
  const chainalysisKey = env.VERIFY_CHAINALYSIS_API_KEY || undefined;
  if (phase === 'run') {
    if (!oneClickKey) {
      throw new UsageError(
        'ONECLICK_API_KEY (the 1Click JWT) must be set: the checks need authenticated pricing, as in production',
      );
    }
    if (!chainalysisKey) {
      throw new UsageError('VERIFY_CHAINALYSIS_API_KEY must be set: check (4) calls Chainalysis');
    }
  }

  const amountOut = value('amount') ?? '1000000';
  if (!/^[1-9]\d{0,17}$/.test(amountOut)) {
    throw new UsageError('--amount must be a positive integer (destination-asset smallest units)');
  }
  const asset = (name: string, dflt: string): string => {
    const v = value(name) ?? dflt;
    if (!/^nep141:[a-z0-9._-]{2,64}$/.test(v)) {
      throw new UsageError(`--${name} must be a nep141: asset id of a NEAR token`);
    }
    return v;
  };
  const originAsset = asset('origin-asset', NEAR_USDT);
  const destAsset = asset('destination-asset', NEAR_USDC);
  if (originAsset === destAsset) {
    throw new UsageError('--origin-asset and --destination-asset must differ');
  }

  const feeAccount = value('fee-account') ?? env.FEE_ACCOUNT_LIVE ?? 'fees.tendr.near';
  if (!NEAR_ACCOUNT.test(feeAccount) || feeAccount.length < 2 || feeAccount.length > 64) {
    throw new UsageError(`--fee-account (${feeAccount}) is not a NEAR account id`);
  }
  if (feeAccount === funderId) {
    throw new UsageError(
      'the fee account must not be the funder account: check (3) and the recipient credit would mix',
    );
  }
  const feeBpsRaw = value('fee-bps') ?? '50';
  const feeBps = /^\d{1,5}$/.test(feeBpsRaw) ? Number(feeBpsRaw) : Number.NaN;
  if (!(feeBps >= 1 && feeBps <= 10_000)) {
    throw new UsageError('--fee-bps must be an integer from 1 to 10000 (check (3) needs a fee)');
  }

  return {
    phase,
    originAsset,
    destAsset,
    amountOut,
    feeAccount,
    feeBps,
    sanctionedAddress: value('sanctioned-address') ?? SANCTIONED_ADDRESS,
    cleanAddress: value('clean-address') ?? CLEAN_ADDRESS,
    funderId,
    funderKey,
    rpcUrl,
    oneClickUrl,
    oneClickKey,
    chainalysisKey,
  };
}

// ─── spend plan and cap ──────────────────────────────────────────────────────

const MICRO = 1_000_000n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** A positive decimal USD string → integer micro-USD, rounded up; null for anything else. */
export function toMicroUsd(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,15})(?:\.(\d{1,30}))?$/.exec(v.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  let micro = BigInt(m[1]!) * MICRO + BigInt(frac.slice(0, 6).padEnd(6, '0'));
  if (/[1-9]/.test(frac.slice(6))) micro += 1n;
  return micro > 0n ? micro : null;
}

/** Micro-USD as a decimal string without trailing zeros (`1262500n` → `1.2625`). */
export function formatMicroUsd(micro: bigint): string {
  const frac = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${micro / MICRO}.${frac}` : `${micro / MICRO}`;
}

/** Micro-USD rounded up to whole cents, two decimals (`3400001n` → `3.41`). */
function formatCentsUp(micro: bigint): string {
  const cents = ceilDiv(micro, 10_000n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** `micro × num / den`, rounded up; null stays null. */
export function scaleMicro(micro: bigint | null, num: bigint, den: bigint): bigint | null {
  return micro === null ? null : ceilDiv(micro * num, den);
}

/** Throws UsageError unless `micro` is a known amount at most MAX_SPEND_MICRO_USD. */
export function assertPlanWithinCap(micro: bigint | null): bigint {
  if (micro === null || micro < 0n) {
    throw new UsageError('refusing to spend: the plan cannot be priced in USD');
  }
  if (micro > MAX_SPEND_MICRO_USD) {
    throw new UsageError(
      `refusing to spend: the plan is worth ${formatMicroUsd(micro)} USD, above the ${MAX_SPEND_USD} USD cap (lower --amount)`,
    );
  }
  return micro;
}

/** 125% of `amountIn`, rounded up: the overpaid send of check (1). */
export function overpayAmount(amountIn: bigint): bigint {
  return ceilDiv(amountIn * 125n, 100n);
}

/** Check (b): the extra deposit after settlement, a tenth of `amountIn` (at least 1 unit). */
export function extraAmount(amountIn: bigint): bigint {
  const e = ceilDiv(amountIn, EXTRA_DIVISOR);
  return e > 0n ? e : 1n;
}

/** Check (1b): the first send is half (rounded down), the top-up the rest. */
export function splitUnderpay(amountIn: bigint): { first: bigint; rest: bigint } {
  const first = amountIn / 2n;
  return { first, rest: amountIn - first };
}

export interface SpendPlan {
  text: string;
  /** Everything at risk, micro-USD: what the cap is checked on. */
  totalMicroUsd: bigint;
  /** The NEAR storage and gas part, micro-USD (committed to the tracker up front). */
  fixedMicroUsd: bigint;
  /** Origin-token units the funder must hold. */
  originUnits: bigint;
  /** NEAR the run spends on storage and gas. */
  nearYocto: bigint;
  /** Check (b)'s extra deposit, origin units. */
  extraUnits: bigint;
}

/**
 * Every spend of a run, from a dry EXACT_OUTPUT quote (`amountIn`, `amountInUsd` for one payment)
 * and the NEAR price, all in integer micro-USD (rounded up). Swap values carry PRICE_MARGIN_PCT.
 * `destStorageYocto` is the funder's registration on the destination token when it is missing.
 */
export function buildSpendPlan(p: {
  amountInUsd: string | undefined;
  amountIn: string;
  originAsset: string;
  nearUsd: string | undefined;
  destStorageYocto?: bigint;
}): SpendPlan {
  const one = toMicroUsd(p.amountInUsd);
  if (one === null) {
    throw new UsageError('refusing to spend: the dry quote has no usable amountInUsd');
  }
  const nearMicro = toMicroUsd(p.nearUsd);
  if (nearMicro === null) {
    throw new UsageError(
      'refusing to spend: 1Click lists no NEAR price, so the plan cannot be capped',
    );
  }
  const destStorage = p.destStorageYocto ?? 0n;
  if (destStorage > DEST_STORAGE_MAX_YOCTO) {
    throw new UsageError(
      `refusing to spend: registering on the destination token costs ${formatNear(destStorage)}, above ${formatNear(DEST_STORAGE_MAX_YOCTO)}`,
    );
  }
  const amountIn = BigInt(p.amountIn);
  const over = ceilDiv(one * 125n, 100n);
  const extra = ceilDiv(one, EXTRA_DIVISOR);
  const swap = ceilDiv((over + extra + one + one) * (100n + PRICE_MARGIN_PCT), 100n);
  const nearYocto = STORAGE_DEPOSIT_NEAR * BigInt(PAYMENTS) + GAS_NEAR + destStorage;
  const fixed = ceilDiv(nearYocto * nearMicro, NEAR);
  const extraUnits = extraAmount(amountIn);
  const lines = [
    'Spend plan (every payment is delivered or refunded to your own intents balance; cleanup returns it):',
    `  - (1) overpay: ${overpayAmount(amountIn)} units of ${p.originAsset}, ${formatMicroUsd(over)} USD`,
    `  - (b) extra deposit to (1)'s address after it settled: ${extraUnits} units, ${formatMicroUsd(extra)} USD (refunded, or swapped to you)`,
    `  - (1b) underpay + top-up: ${amountIn} units in two sends, ${formatMicroUsd(one)} USD`,
    `  - (2) late deposit: ${amountIn} units, ${formatMicroUsd(one)} USD (refunded, or swapped to you)`,
  ];
  if (destStorage > 0n) {
    lines.push(
      `  - your registration on the destination token (cleanup needs it): ${formatNear(destStorage)}: LOST`,
    );
  }
  lines.push(
    `  - NEAR storage and gas in all: up to ${formatNear(nearYocto)} (${formatMicroUsd(fixed)} USD): LOST`,
    `  - LOST in every payment: the appFees share to the fee account, 1Click's fee and the spread`,
    `  Total at risk, with a ${PRICE_MARGIN_PCT}% price margin: ${formatMicroUsd(swap + fixed)} USD (cap ${MAX_SPEND_USD} USD)`,
  );
  return {
    text: lines.join('\n'),
    totalMicroUsd: swap + fixed,
    fixedMicroUsd: fixed,
    originUnits: overpayAmount(amountIn) + amountIn + amountIn + extraUnits,
    nearYocto,
    extraUnits,
  };
}

/** Running total of what a run has committed (micro-USD); refuses any send past the cap. */
export class SpendTracker {
  private spent: bigint;

  constructor(fixedMicroUsd: bigint) {
    this.spent = fixedMicroUsd;
  }

  get totalMicroUsd(): bigint {
    return this.spent;
  }

  commit(micro: bigint | null, what: string): void {
    if (micro === null || micro < 0n) {
      throw new UsageError(`refusing to send ${what}: it cannot be priced in USD`);
    }
    if (this.spent + micro > MAX_SPEND_MICRO_USD) {
      throw new UsageError(
        `refusing to send ${what}: ${formatMicroUsd(micro)} USD would bring the run to ${formatMicroUsd(this.spent + micro)} USD, above the ${MAX_SPEND_USD} USD cap`,
      );
    }
    this.spent += micro;
  }
}

/** Asks the operator to type CONFIRM_WORD before a run spends. True only on exactly that word. */
export async function confirmSpend(
  totalMicroUsd: bigint,
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  const answer = await ask(
    `Spend up to ${formatCentsUp(totalMicroUsd)} USD on mainnet? Type "${CONFIRM_WORD}" to go ahead: `,
  );
  return answer.trim() === CONFIRM_WORD;
}

/** Asks the operator to type WITHDRAW_WORD before cleanup withdraws. True only on that word. */
export async function confirmWithdraw(
  funderId: string,
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  const answer = await ask(
    `Withdraw your remaining balance to ${funderId}? Type "${WITHDRAW_WORD}" to go ahead: `,
  );
  return answer.trim() === WITHDRAW_WORD;
}

/** The credit check of (1): exact, more than required, short, or none. */
export function summarizeCredits(
  credits: readonly { amount: bigint }[],
  required: bigint,
): { verdict: 'exact' | 'more' | 'short' | 'none'; best: bigint } {
  if (credits.length === 0) return { verdict: 'none', best: 0n };
  if (credits.some((c) => c.amount === required)) return { verdict: 'exact', best: required };
  const above = credits.filter((c) => c.amount > required).map((c) => c.amount);
  if (above.length > 0) {
    return { verdict: 'more', best: above.reduce((a, b) => (b < a ? b : a)) };
  }
  return { verdict: 'short', best: credits.map((c) => c.amount).reduce((a, b) => (b > a ? b : a)) };
}

export function cleanupCommand(): string {
  return `npm run checkout:verify:mainnet --workspace=@tendr/api -- --${CONFIRM_FLAG} --phase cleanup`;
}

// ─── reporting ───────────────────────────────────────────────────────────────

/** A FAIL: stops the run. */
export class CheckFailed extends Error {}

const report = {
  pass: (name: string, detail = '') => console.log(`PASS: ${name}${detail ? ` (${detail})` : ''}`),
  info: (name: string, detail = '') => console.log(`INFO: ${name}${detail ? `: ${detail}` : ''}`),
  inconclusive: (name: string, detail: string) => console.log(`INCONCLUSIVE: ${name}: ${detail}`),
  fail: (name: string, detail: string): never => {
    console.log(`FAIL: ${name}: ${detail}`);
    throw new CheckFailed(`${name}: ${detail}`);
  },
};

/** A check that ran but could not decide: printed as INCONCLUSIVE; the run goes on. */
class Inconclusive {
  constructor(readonly detail: string) {}
}

/** Runs `fn`; an exception becomes a FAIL and stops the run. */
async function check(name: string, fn: () => Promise<string | void | Inconclusive>): Promise<void> {
  try {
    const detail = await fn();
    if (detail instanceof Inconclusive) report.inconclusive(name, detail.detail);
    else report.pass(name, detail ?? '');
  } catch (err) {
    if (err instanceof CheckFailed || err instanceof UsageError) throw err;
    report.fail(name, (err as Error).message);
  }
}

const clip = (s: string, n = 2000): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── context ─────────────────────────────────────────────────────────────────

interface Ctx {
  a: VerifyArgs;
  funder: ScriptAccount;
  oneclick: HttpOneClick;
  /** The raw body of the last 1Click response, for check (c). */
  lastRaw: { path: string; body: string };
  tracker: SpendTracker | null;
}

function openCtx(a: VerifyArgs): Ctx {
  const lastRaw = { path: '', body: '' };
  // Records each raw body before the API's own client parses it (check (c)).
  const recording: FetchLike = async (url, init) => {
    const res = await fetch(url, init);
    const body = await res.text();
    lastRaw.path = new URL(url).pathname;
    lastRaw.body = body;
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  };
  return {
    a,
    funder: ScriptAccount.open(a.funderId, a.funderKey, a.rpcUrl),
    oneclick: new HttpOneClick({
      baseUrl: a.oneClickUrl,
      ...(a.oneClickKey ? { apiKey: a.oneClickKey } : {}),
      fetch: recording,
    }),
    lastRaw,
    tracker: null,
  };
}

const tokenAccount = (asset: string): string => asset.replace(/^nep141:/, '');

async function intentsBalance(c: Ctx, account: string, asset: string): Promise<bigint> {
  const r = await c.funder.rpc.viewFunction<string[]>(INTENTS, 'mt_batch_balance_of', {
    account_id: account,
    token_ids: [asset],
  });
  return BigInt(r[0] ?? '0');
}

async function viewOrNull<T>(contract: string, c: Ctx, method: string, args: object) {
  try {
    return await c.funder.rpc.viewFunction<T>(contract, method, args);
  } catch {
    return null;
  }
}

/** The quote body Tendr's API sends (pricing.ts `base`), shopper-pays shape (EXACT_OUTPUT). */
function quoteRequest(a: VerifyArgs, dry: boolean, ttlMs = QUOTE_TTL_MS): QuoteRequest {
  return {
    dry,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: a.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: a.destAsset,
    amount: a.amountOut,
    refundTo: a.funderId,
    refundType: 'INTENTS',
    recipient: a.funderId,
    recipientType: 'INTENTS',
    deadline: new Date(Date.now() + ttlMs).toISOString(),
    appFees: [{ recipient: a.feeAccount, fee: a.feeBps }],
  };
}

async function quote(c: Ctx, req: QuoteRequest, label: string): Promise<QuoteResponse> {
  let q: QuoteResponse;
  try {
    q = await c.oneclick.quote(req);
  } catch (err) {
    report.info(`(c) raw ${label} response`, clip(c.lastRaw.body));
    throw err;
  }
  report.info(`(c) raw ${label} response`, clip(c.lastRaw.body));
  report.info(`(c) ${label} parsed by oneclick/http.ts`, JSON.stringify(q.quote));
  return q;
}

async function status(c: Ctx, depositAddress: string): Promise<{ s: StatusResponse; raw: string }> {
  const s = await c.oneclick.status(depositAddress);
  return { s, raw: c.lastRaw.body };
}

/**
 * Polls until `done(status)` or the timeout; prints each status change. A failed poll (network,
 * or a body oneclick/http.ts cannot parse) is printed with the raw body and retried: money may
 * already be in flight, so one bad answer must not end the run.
 */
async function waitFor(
  c: Ctx,
  depositAddress: string,
  label: string,
  done: (s: StatusResponse) => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<{ s: StatusResponse; raw: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    let r: { s: StatusResponse; raw: string } | null = null;
    try {
      r = await status(c, depositAddress);
    } catch (err) {
      const line = `error ${(err as Error).message}; raw ${clip(c.lastRaw.body, 500)}`;
      if (line !== last) report.info(`${label}: 1Click status poll`, line);
      last = line;
    }
    if (r && r.s.status !== last) {
      report.info(`${label}: 1Click status`, r.s.status);
      last = r.s.status;
    }
    if (r && done(r.s)) return r;
    if (Date.now() > deadline) {
      throw new Error(`${label}: still ${last} after ${Math.round(timeoutMs / 60_000)} min`);
    }
    await sleep(POLL_MS);
  }
}

/** Registers the deposit address on the origin token when needed, sends `amount`, tells 1Click. */
async function fund(c: Ctx, depositAddress: string, amount: bigint, what: string): Promise<string> {
  const token = tokenAccount(c.a.originAsset);
  const registered = await viewOrNull<object>(token, c, 'storage_balance_of', {
    account_id: depositAddress,
  });
  if (!registered) {
    const bounds = await viewOrNull<{ min: string }>(token, c, 'storage_balance_bounds', {});
    const min = BigInt(bounds?.min ?? STORAGE_DEPOSIT_NEAR.toString());
    if (min > STORAGE_DEPOSIT_NEAR) {
      throw new UsageError(
        `refusing to send ${what}: ${token} storage costs ${formatNear(min)}, above the planned ${formatNear(STORAGE_DEPOSIT_NEAR)}`,
      );
    }
    await c.funder.sendOk(
      token,
      [
        functionCallAction(
          'storage_deposit',
          { account_id: depositAddress, registration_only: true },
          30n * TGAS,
          min,
        ),
      ],
      `storage_deposit for ${depositAddress}`,
    );
  }
  const o = await c.funder.sendOk(
    token,
    [
      functionCallAction(
        'ft_transfer',
        { receiver_id: depositAddress, amount: amount.toString() },
        30n * TGAS,
        1n,
      ),
    ],
    `ft_transfer (${what})`,
  );
  const hash = o.transaction?.hash ?? o.transaction_outcome?.id ?? '';
  try {
    await c.oneclick.submitDeposit(hash, depositAddress);
  } catch (err) {
    report.info(`deposit/submit for ${what} (optional)`, (err as Error).message);
  }
  report.info(`sent ${what}`, `${amount} of ${c.a.originAsset} to ${depositAddress}, tx ${hash}`);
  return hash;
}

/** Commits num/den of a quote's USD value (micro-USD, rounded up) to the tracker. */
function commit(c: Ctx, q: QuoteResponse, num: bigint, den: bigint, what: string): void {
  c.tracker!.commit(scaleMicro(toMicroUsd(q.quote.amountInUsd), num, den), what);
}

/** Waits until the account's intents balance of `asset` rises above `before`; returns the delta. */
async function balanceRise(
  c: Ctx,
  account: string,
  asset: string,
  before: bigint,
  timeoutMs: number,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await intentsBalance(c, account, asset);
    if (now > before) return now - before;
    if (Date.now() > deadline) return 0n;
    await sleep(POLL_MS);
  }
}

// ─── free checks ─────────────────────────────────────────────────────────────

async function chainalysis(c: Ctx, address: string): Promise<unknown[]> {
  const res = await fetch(`${CHAINALYSIS_URL}${encodeURIComponent(address)}`, {
    headers: { 'X-API-Key': c.a.chainalysisKey!, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chainalysis HTTP ${res.status}: ${clip(text, 300)}`);
  const body = JSON.parse(text) as { identifications?: unknown };
  if (!Array.isArray(body.identifications)) {
    throw new Error(
      `no identifications array in ${clip(text, 300)} (screening.ts would fail closed)`,
    );
  }
  return body.identifications;
}

async function check4(c: Ctx): Promise<void> {
  await check(
    '(4) Chainalysis identifies a sanctioned address and clears a clean one',
    async () => {
      const hit = await chainalysis(c, c.a.sanctionedAddress);
      report.info('(4) sanctioned address identifications', clip(JSON.stringify(hit), 600));
      if (hit.length === 0) throw new Error(`${c.a.sanctionedAddress} returned no identifications`);
      const clean = await chainalysis(c, c.a.cleanAddress);
      if (clean.length !== 0) {
        throw new Error(`${c.a.cleanAddress} returned identifications: ${JSON.stringify(clean)}`);
      }
      return `${hit.length} identification(s) for ${c.a.sanctionedAddress}, none for ${c.a.cleanAddress}`;
    },
  );
}

// ─── (a) settlement receipts ─────────────────────────────────────────────────

function printReceipts(label: string, receipts: readonly TxReceipt[]): void {
  for (const r of receipts) {
    const events = r.logs
      .map((l) => parseEventLog(l))
      .filter((e) => e !== null)
      .map((e) => JSON.stringify(e));
    report.info(
      `${label} receipt ${r.receiptId}`,
      `executor=${r.executorId} predecessor=${r.predecessorId ?? '?'} ok=${r.ok} events=${clip(events.join(' | ') || '(none)', 1500)}`,
    );
  }
}

/**
 * (a) + the verifier half of (1): fetches every destination tx the way the watcher does
 * (`tx_status` routed via intents.near) and also via the token contract and the recipient, prints
 * the receipts and events, and returns the recipient's matching NEP-245 credits.
 */
async function settlementCredits(c: Ctx, s: StatusResponse, label: string) {
  const hashes = s.swapDetails.destinationChainTxHashes.map((h) => h.hash);
  report.info(`${label} destinationChainTxHashes`, hashes.join(', ') || '(none)');
  const credits: { amount: bigint; hash: string; receiptId: string }[] = [];
  let viaIntents = 0;
  for (const hash of hashes) {
    for (const route of [INTENTS, tokenAccount(c.a.destAsset), c.a.funderId]) {
      let tx;
      try {
        tx = await c.funder.rpc.txStatus(hash, route);
      } catch (err) {
        report.info(`(a) tx_status ${hash} via ${route}`, `error ${(err as Error).message}`);
        continue;
      }
      report.info(
        `(a) tx_status ${hash} via ${route}`,
        tx ? `found: signer=${tx.signerId} receiver=${tx.receiverId}` : 'unknown transaction',
      );
      if (!tx || route !== INTENTS) continue;
      viaIntents += 1;
      printReceipts(`(a) ${hash}`, tx.receipts);
      for (const m of matchingCredits(tx.receipts, {
        assetId: c.a.destAsset,
        receiver: c.a.funderId,
        intentsContract: INTENTS,
      })) {
        credits.push({ amount: m.amount, hash, receiptId: m.receiptId });
      }
    }
  }
  return { credits, viaIntents, hashes };
}

// ─── the paid checks ─────────────────────────────────────────────────────────

async function check1(c: Ctx): Promise<void> {
  const required = BigInt(c.a.amountOut);
  const destBefore = await intentsBalance(c, c.a.funderId, c.a.destAsset);
  const originBefore = await intentsBalance(c, c.a.funderId, c.a.originAsset);
  const feeBefore = {
    dest: await intentsBalance(c, c.a.feeAccount, c.a.destAsset),
    origin: await intentsBalance(c, c.a.feeAccount, c.a.originAsset),
  };
  // Set by the first check below (a FAIL there stops the run before it is read).
  const box: { final?: { s: StatusResponse; raw: string }; q?: QuoteResponse } = {};

  await check('(1) EXACT_OUTPUT overpaid by 25%: 1Click settles', async () => {
    const q = await quote(c, quoteRequest(c.a, false), '(1) real quote');
    if (!q.quote.depositAddress) throw new Error('the real quote has no depositAddress');
    box.q = q;
    commit(c, q, 125n, 100n, '(1) overpay');
    const send = overpayAmount(BigInt(q.quote.amountIn));
    await fund(c, q.quote.depositAddress, send, '(1) overpay');
    const final = await waitFor(c, q.quote.depositAddress, '(1)', (s) =>
      ['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status),
    );
    box.final = final;
    report.info('(5) raw 1Click status at the end of (1)', clip(final.raw));
    if (final.s.status !== 'SUCCESS') throw new Error(`ended ${final.s.status}`);
    return `sent ${send} for amountIn ${q.quote.amountIn}; amountOut ${final.s.swapDetails.amountOut ?? '?'}`;
  });
  const { final, q } = box as Required<typeof box>;
  const s = final.s;

  await check(
    '(1) the recipient is credited exactly amount_out (no more, no less), as the watcher finds it',
    async () => {
      const { credits, viaIntents, hashes } = await settlementCredits(c, s, '(1)');
      if (hashes.length === 0) throw new Error('1Click reported no destinationChainTxHashes');
      if (viaIntents === 0) {
        throw new Error(
          'no destination tx is found by tx_status routed via intents.near, which is how watcher.verify looks it up: see the (a) lines for the route that works',
        );
      }
      const r = summarizeCredits(credits, required);
      const delta = (await intentsBalance(c, c.a.funderId, c.a.destAsset)) - destBefore;
      report.info('(1) recipient intents balance delta (cross-check only)', delta.toString());
      if (r.verdict === 'none') {
        throw new Error(`no NEP-245 credit of ${c.a.destAsset} to ${c.a.funderId} in the receipts`);
      }
      if (r.verdict === 'short') {
        throw new Error(`largest credit ${r.best} < amount_out ${required}`);
      }
      if (r.verdict === 'more') {
        throw new Error(
          `credit ${r.best} > amount_out ${required}: EXACT_OUTPUT is not exact (part of the overpaid excess was swapped to the recipient instead of returned)`,
        );
      }
      return `credit ${r.best} == amount_out ${required}`;
    },
  );

  await check('(1) the overpaid excess reaches refundTo', async () => {
    report.info('(1) 1Click refundedAmount', s.swapDetails.refundedAmount ?? '(absent)');
    const back = await balanceRise(c, c.a.funderId, c.a.originAsset, originBefore, 10 * 60_000);
    if (back === 0n) {
      throw new Error(
        `refundTo (${c.a.funderId}, INTENTS) received no ${c.a.originAsset} within 10 min`,
      );
    }
    return `${back} of ${c.a.originAsset} returned to refundTo`;
  });

  await check('(3) the appFees share reaches the fee account', async () => {
    const dest = await balanceRise(c, c.a.feeAccount, c.a.destAsset, feeBefore.dest, 5 * 60_000);
    const origin = await balanceRise(c, c.a.feeAccount, c.a.originAsset, feeBefore.origin, 60_000);
    report.info(
      '(3) fee account intents deltas (a balance delta: only meaningful before live fees flow)',
      `${c.a.destAsset}: ${dest}, ${c.a.originAsset}: ${origin}; expected about ${(required * BigInt(c.a.feeBps)) / 10_000n} at ${c.a.feeBps} bps of amount_out`,
    );
    if (dest === 0n && origin === 0n) {
      throw new Error(`${c.a.feeAccount} received nothing in either asset`);
    }
    return dest > 0n ? `${dest} of ${c.a.destAsset}` : `${origin} of ${c.a.originAsset}`;
  });

  // (5) INFO: what 1Click reports about the deposit, and whether the sender can be read.
  const origins = s.swapDetails.originChainTxHashes.map((h) => h.hash);
  report.info('(5) status fields', Object.keys(JSON.parse(final.raw) as object).join(', '));
  report.info('(5) originChainTxHashes', origins.join(', ') || '(none: the sender cannot be read)');
  for (const hash of origins) {
    const tx = await c.funder.rpc.txStatus(hash, c.a.funderId).catch(() => null);
    report.info(
      `(5) sender of origin tx ${hash}`,
      tx
        ? `${tx.signerId} (${tx.signerId === c.a.funderId ? 'matches' : 'differs from'} the funder)`
        : 'tx not found',
    );
  }

  await checkExtraAfterSettlement(c, q, s);
}

const describeStatus = (s: StatusResponse): string =>
  `status=${s.status} depositedAmount=${s.swapDetails.depositedAmount ?? '(absent)'} refundedAmount=${s.swapDetails.refundedAmount ?? '(absent)'} amountOut=${s.swapDetails.amountOut ?? '(absent)'} originChainTxHashes=[${s.swapDetails.originChainTxHashes.map((h) => h.hash).join(', ')}]`;

/**
 * (b) Ledger item "top-up after settlement": a small extra deposit to (1)'s deposit address after
 * 1Click reported SUCCESS. All INFO (the spec defines no required outcome): depositedAmount
 * before/after, whether the new origin hash is listed, and whether the extra came back (refunded)
 * or was swapped to the recipient. The watcher's late / seen-hash handling must match what this
 * prints (watcher.ts classify and detect).
 */
async function checkExtraAfterSettlement(
  c: Ctx,
  q: QuoteResponse,
  settled: StatusResponse,
): Promise<void> {
  const addr = q.quote.depositAddress!;
  const amountIn = BigInt(q.quote.amountIn);
  const extra = extraAmount(amountIn);
  report.info('(b) before the extra deposit', describeStatus(settled));
  const before = settled.swapDetails;
  const originBefore = await intentsBalance(c, c.a.funderId, c.a.originAsset);
  const destBefore = await intentsBalance(c, c.a.funderId, c.a.destAsset);
  const box: { hash?: string } = {};
  await check("(b) send an extra deposit to (1)'s address after it settled", async () => {
    c.tracker!.commit(
      scaleMicro(toMicroUsd(q.quote.amountInUsd), extra, amountIn),
      '(b) extra deposit',
    );
    box.hash = await fund(c, addr, extra, '(b) extra after settlement');
    return `${extra} of ${c.a.originAsset}, tx ${box.hash}`;
  });
  const hash = box.hash!;

  const after = await waitFor(
    c,
    addr,
    '(b) after the extra deposit',
    (s) =>
      s.swapDetails.originChainTxHashes.some((h) => h.hash === hash) ||
      s.swapDetails.depositedAmount !== before.depositedAmount ||
      s.status !== settled.status,
    EXTRA_WAIT_MS,
  ).catch((err: Error) => {
    report.info('(b) 1Click never reported the extra deposit', err.message);
    return null;
  });
  if (after) {
    report.info('(b) raw 1Click status after the extra deposit', clip(after.raw));
    report.info('(b) after the extra deposit', describeStatus(after.s));
  }
  const listed = after?.s.swapDetails.originChainTxHashes.some((h) => h.hash === hash) ?? false;
  report.info(
    '(b) depositedAmount growth vs seen hashes',
    `depositedAmount ${before.depositedAmount ?? '(absent)'} -> ${after?.s.swapDetails.depositedAmount ?? '(unknown)'} (extra ${extra}); new hash ${hash} ${listed ? 'IS' : 'is NOT'} listed; status ${settled.status} -> ${after?.s.status ?? '(unknown)'}`,
  );

  // Where did the extra go? A rise in the refundTo origin balance = refunded; in the recipient's
  // settlement balance = swapped.
  const deadline = Date.now() + EXTRA_WAIT_MS;
  let outcome = 'neither refunded nor swapped within 15 min (check the 1Click explorer by hand)';
  for (;;) {
    const back = (await intentsBalance(c, c.a.funderId, c.a.originAsset)) - originBefore;
    const out = (await intentsBalance(c, c.a.funderId, c.a.destAsset)) - destBefore;
    if (back > 0n) {
      outcome = `REFUNDED: ${back} of ${c.a.originAsset} back to refundTo`;
      break;
    }
    if (out > 0n) {
      outcome = `SWAPPED: ${out} of ${c.a.destAsset} credited to the recipient`;
      break;
    }
    if (Date.now() > deadline) break;
    await sleep(POLL_MS);
  }
  report.info('(b) the extra deposit was', outcome);
  report.info(
    '(b) watcher implication',
    `a deposit after SUCCESS ${listed ? 'appears as a new origin hash on the same deposit address' : 'does not appear in originChainTxHashes'}; ${outcome.startsWith('SWAPPED') ? 'it reaches the merchant, so it must become a late payment and go through return-to-sender' : outcome.startsWith('REFUNDED') ? '1Click returns it itself, so the watcher must only record it' : 'decide by hand'}`,
  );
}

async function check1b(c: Ctx): Promise<void> {
  await check('(1b) a top-up to the same address before the deadline is accumulated', async () => {
    const q = await quote(c, quoteRequest(c.a, false), '(1b) real quote');
    const addr = q.quote.depositAddress;
    if (!addr) throw new Error('the real quote has no depositAddress');
    commit(c, q, 1n, 1n, '(1b) underpay + top-up');
    const { first, rest } = splitUnderpay(BigInt(q.quote.amountIn));
    const h1 = await fund(c, addr, first, '(1b) first half');
    const mid = await waitFor(
      c,
      addr,
      '(1b) after the first half',
      (s) =>
        s.status === 'INCOMPLETE_DEPOSIT' || ['REFUNDED', 'FAILED', 'SUCCESS'].includes(s.status),
      8 * 60_000,
    ).catch((err: Error) => {
      report.info('(1b) INCOMPLETE_DEPOSIT not seen before the top-up', err.message);
      return null;
    });
    const sawUnderpay = mid?.s.status === 'INCOMPLETE_DEPOSIT';
    if (mid) {
      report.info('(5) raw 1Click status after an underpay', clip(mid.raw));
      report.info('(1b) after the first half', describeStatus(mid.s));
      if (mid.s.status === 'REFUNDED') {
        throw new Error(
          '1Click refunded the half deposit before the deadline instead of waiting for the rest: no top-up window; keep CHECKOUT_TOPUP_ENABLED unset in live',
        );
      }
      if (!sawUnderpay) {
        throw new Error(`after the first half 1Click reported ${mid.s.status}`);
      }
    }
    // The funds are committed: the top-up is sent even when the underpay was not observed.
    const h2 = await fund(c, addr, rest, '(1b) top-up');
    const end = await waitFor(c, addr, '(1b) after the top-up', (s) =>
      ['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status),
    );
    const deposited = end.s.swapDetails.depositedAmount;
    const seen = end.s.swapDetails.originChainTxHashes.map((h) => h.hash);
    report.info(
      '(1b) depositedAmount vs origin tx hashes',
      `depositedAmount=${deposited ?? '(absent)'} (sent ${first} + ${rest} = ${first + rest}); hashes listed: ${seen.join(', ') || '(none)'}; first ${seen.includes(h1) ? 'listed' : 'NOT listed'}, top-up ${seen.includes(h2) ? 'listed' : 'NOT listed'}`,
    );
    if (!sawUnderpay) {
      return new Inconclusive(
        `1Click never reported INCOMPLETE_DEPOSIT for the first half, so both halves may have been counted as one deposit (ended ${end.s.status}); keep CHECKOUT_TOPUP_ENABLED unset in live`,
      );
    }
    if (end.s.status !== 'SUCCESS') {
      throw new Error(
        `INCOMPLETE_DEPOSIT, then ${end.s.status} after the top-up: 1Click did not accumulate it; keep CHECKOUT_TOPUP_ENABLED unset in live`,
      );
    }
    const accumulated =
      (deposited !== undefined && /^\d+$/.test(deposited) && BigInt(deposited) >= first + rest) ||
      (seen.includes(h1) && seen.includes(h2));
    if (!accumulated) {
      return new Inconclusive(
        `SUCCESS, but neither depositedAmount (${deposited ?? 'absent'}) nor the listed hashes show both sends counted; keep CHECKOUT_TOPUP_ENABLED unset in live`,
      );
    }
    const { credits } = await settlementCredits(c, end.s, '(1b)');
    const r = summarizeCredits(credits, BigInt(c.a.amountOut));
    if (r.verdict === 'none' || r.verdict === 'short') {
      throw new Error(`SUCCESS but no settlement credit ≥ amount_out (${r.verdict} ${r.best})`);
    }
    return 'INCOMPLETE_DEPOSIT seen, then the accumulated deposit settled: CHECKOUT_TOPUP_ENABLED=true is safe in live';
  });
}

async function check2(c: Ctx): Promise<void> {
  await check('(2) a deposit after the quote deadline is refunded or swapped', async () => {
    const q = await quote(c, quoteRequest(c.a, false, LATE_QUOTE_TTL_MS), '(2) real quote');
    const addr = q.quote.depositAddress;
    if (!addr) throw new Error('the real quote has no depositAddress');
    const deadline = new Date(q.quote.deadline ?? Date.now() + LATE_QUOTE_TTL_MS).getTime();
    commit(c, q, 1n, 1n, '(2) late deposit');
    const wait = deadline + LATE_SEND_AFTER_DEADLINE_MS - Date.now();
    report.info(
      '(2) waiting past the quote deadline',
      `${Math.ceil(Math.max(wait, 0) / 1000)} s (deadline ${new Date(deadline).toISOString()})`,
    );
    if (wait > 0) await sleep(wait);
    await fund(c, addr, BigInt(q.quote.amountIn), '(2) late deposit');
    const end = await waitFor(c, addr, '(2)', (s) =>
      ['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status),
    );
    report.info('(5) raw 1Click status of a late deposit', clip(end.raw));
    if (end.s.status === 'FAILED') throw new Error('1Click reported FAILED for a late deposit');
    return end.s.status === 'REFUNDED'
      ? `REFUNDED (refundedAmount ${end.s.swapDetails.refundedAmount ?? '?'}, reason ${end.s.swapDetails.refundReason ?? '?'})`
      : `SWAPPED at the old terms (amountOut ${end.s.swapDetails.amountOut ?? '?'}): the return-to-sender path handles it`;
  });
}

// ─── phases ──────────────────────────────────────────────────────────────────

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UsageError('refusing to spend: the confirmation needs an interactive terminal');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function run(c: Ctx): Promise<void> {
  await check4(c);

  // A dry quote spends nothing: it prices the plan and shows the wire shape (c).
  const box: { dry?: QuoteResponse; nearUsd?: string; destStorage?: bigint } = {};
  await check('(c) the dry quote and token list parse with oneclick/http.ts', async () => {
    box.dry = await quote(c, quoteRequest(c.a, true), '(c) dry quote');
    const tokens = await c.oneclick.tokens();
    box.nearUsd = tokens.find((t) => t.assetId === WNEAR)?.priceUsd;
    return `${tokens.length} tokens; ${WNEAR} at ${box.nearUsd ?? '(no price)'} USD`;
  });

  // Cleanup withdraws the delivered settlement asset to the funder's wallet, which needs the
  // funder registered (NEP-145) on the destination token. Free to read; paid after confirmation.
  await check('preflight: the funder can receive the destination token on cleanup', async () => {
    const token = tokenAccount(c.a.destAsset);
    const mine = await viewOrNull<object>(token, c, 'storage_balance_of', {
      account_id: c.a.funderId,
    });
    if (mine) {
      box.destStorage = 0n;
      return `already registered on ${token}`;
    }
    const bounds = await viewOrNull<{ min: string }>(token, c, 'storage_balance_bounds', {});
    if (!bounds || !/^\d+$/.test(bounds.min)) {
      throw new UsageError(
        `refusing to spend: ${c.a.funderId} is not registered on ${token} and its storage_balance_bounds cannot be read. Register first: call ${token} storage_deposit {"account_id":"${c.a.funderId}","registration_only":true} with the deposit the token asks for`,
      );
    }
    const min = BigInt(bounds.min);
    if (min > DEST_STORAGE_MAX_YOCTO) {
      throw new UsageError(
        `refusing to spend: registering ${c.a.funderId} on ${token} costs ${formatNear(min)}, above ${formatNear(DEST_STORAGE_MAX_YOCTO)}. Register yourself first: call ${token} storage_deposit {"account_id":"${c.a.funderId}","registration_only":true} with ${formatNear(min)} attached`,
      );
    }
    box.destStorage = min;
    return `not registered on ${token}; registering costs ${formatNear(min)} (in the plan)`;
  });

  const plan = buildSpendPlan({
    amountInUsd: box.dry!.quote.amountInUsd,
    amountIn: box.dry!.quote.amountIn,
    originAsset: c.a.originAsset,
    nearUsd: box.nearUsd,
    destStorageYocto: box.destStorage ?? 0n,
  });
  console.log(`\n${plan.text}\n`);
  assertPlanWithinCap(plan.totalMicroUsd);

  await check('preflight: the funder account, key and balances cover the plan', async () => {
    const keys = await c.funder.rpc.accessKeyList(c.a.funderId);
    if (!keys.includes(c.funder.publicKey.nearPublicKey)) {
      throw new Error('VERIFY_FUNDER_PRIVATE_KEY is not an access key of the funder account');
    }
    const near = await c.funder.accountBalance(c.a.funderId);
    const needNear = plan.nearYocto + NEAR / 10n;
    if (near < needNear) {
      throw new Error(`${c.a.funderId} holds ${formatNear(near)}; needs ${formatNear(needNear)}`);
    }
    const token = tokenAccount(c.a.originAsset);
    const held = BigInt(
      await c.funder.rpc.viewFunction<string>(token, 'ft_balance_of', { account_id: c.a.funderId }),
    );
    const needToken = (plan.originUnits * 105n) / 100n;
    if (held < needToken) throw new Error(`holds ${held} of ${token}; needs ${needToken}`);
    return `${formatNear(near)}, ${held} of ${token}`;
  });

  if (!(await confirmSpend(plan.totalMicroUsd, ask))) {
    throw new UsageError('not confirmed; nothing was spent');
  }
  c.tracker = new SpendTracker(plan.fixedMicroUsd);

  if (box.destStorage && box.destStorage > 0n) {
    const deposit = box.destStorage;
    await check('register the funder on the destination token', async () => {
      const token = tokenAccount(c.a.destAsset);
      await c.funder.sendOk(
        token,
        [
          functionCallAction(
            'storage_deposit',
            { account_id: c.a.funderId, registration_only: true },
            30n * TGAS,
            deposit,
          ),
        ],
        `storage_deposit for ${c.a.funderId} on ${token}`,
      );
      return `${formatNear(deposit)} on ${token}`;
    });
  }

  await check1(c);
  await check1b(c);
  await check2(c);
  console.log(
    `\nDONE: no FAIL (committed about ${formatMicroUsd(c.tracker.totalMicroUsd)} USD). Read the INFO and INCONCLUSIVE lines.`,
  );
}

/** Withdraws the funder's intents balances of both assets back to its wallet balance. */
async function cleanup(c: Ctx): Promise<void> {
  const assets = [c.a.originAsset, c.a.destAsset];
  const held = await Promise.all(assets.map((asset) => intentsBalance(c, c.a.funderId, asset)));
  for (const [i, asset] of assets.entries())
    report.info('intents balance', `${held[i]} of ${asset}`);
  if (held.every((h) => h === 0n)) {
    report.pass('cleanup: nothing to withdraw');
    return;
  }
  if (!(await confirmWithdraw(c.a.funderId, ask))) {
    throw new UsageError('not confirmed; nothing was sent');
  }
  for (const [i, asset] of assets.entries()) {
    const amount = held[i]!;
    if (amount === 0n) continue;
    await check(`cleanup: withdraw ${amount} of ${asset} to ${c.a.funderId}`, async () => {
      const o = await c.funder.send(INTENTS, [
        functionCallAction(
          'ft_withdraw',
          { token: tokenAccount(asset), receiver_id: c.a.funderId, amount: amount.toString() },
          100n * TGAS,
          1n,
        ),
      ]);
      const failure = firstFailure(o);
      if (failure) throw new Error(failure);
      const after = await intentsBalance(c, c.a.funderId, asset);
      if (after !== 0n) throw new Error(`intents balance is still ${after}`);
      return `tx ${o.transaction?.hash ?? ''}`;
    });
  }
}

async function main(a: VerifyArgs): Promise<void> {
  console.log(PLAN_TEXT);
  console.log(
    `phase: ${a.phase}   funder: ${a.funderId}   rpc: ${a.rpcUrl}   1Click: ${a.oneClickUrl}\n`,
  );
  const c = openCtx(a);
  try {
    if (a.phase === 'run') await run(c);
    else await cleanup(c);
  } catch (err) {
    if (a.phase === 'run' && c.tracker) {
      console.error(
        `\nWithdraw what was delivered or refunded to you with:\n  ${cleanupCommand()}`,
      );
    }
    throw err;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  main(args).then(
    () => process.exit(0),
    (err: unknown) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exit(2);
      }
      console.error(`STOPPED: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
