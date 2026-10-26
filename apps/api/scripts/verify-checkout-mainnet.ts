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
 * Output is PASS / FAIL / INFO per check, and the run stops at the first FAIL. The checks, in order:
 *   (4)  Chainalysis: `identifications` for a known sanctioned address, none for a clean one (free)
 *   (c)  INFO: the raw 1Click dry-quote body, parsed by the API's own client (oneclick/http.ts)
 *   --- spend plan, cap check, typed confirmation; nothing is spent before this ---
 *   (1)  EXACT_OUTPUT, overpaid by 25%: the recipient is credited exactly amount_out, found the way
 *        the watcher's verifier finds it (settlement tx receipts, NEP-245 event); the excess
 *        reaches refundTo
 *   (a)  INFO: which account routes tx_status to the settlement tx, and its receipts and events
 *   (3)  the appFees share reaches the fee account's intents balance
 *   (5)  INFO: the raw 1Click status bodies; whether the origin tx (and so the sender) is present
 *   (1b) underpay by half, then top up the same deposit address before the deadline: 1Click
 *        accumulates the deposits and settles (PASS lets you set CHECKOUT_TOPUP_ENABLED=true)
 *   (b)  INFO: depositedAmount after each send vs the origin tx hashes 1Click lists
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
/** Hard cap on everything one run may spend or put at risk, in USD. */
export const MAX_SPEND_USD = 5;

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
/** Margin on the swap value for price movement between the dry and real quotes. */
const PRICE_MARGIN = 1.05;
/** NEP-145 registration of a 1Click deposit address on the origin token, per payment. */
const STORAGE_DEPOSIT_NEAR = (125n * NEAR) / 100_000n; // 0.00125 NEAR
const PAYMENTS = 3;
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
  `1 USD each (one overpaid by 25%), NEAR for gas and storage, all capped at ${MAX_SPEND_USD} USD in total.`,
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

const fmtUsd = (usd: number): string => String(Number(usd.toFixed(4)));

/** Throws UsageError unless `usd` is a real number at most MAX_SPEND_USD. */
export function assertPlanWithinCap(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new UsageError('refusing to spend: the plan cannot be priced in USD');
  }
  if (usd > MAX_SPEND_USD) {
    throw new UsageError(
      `refusing to spend: the plan is worth ${fmtUsd(usd)} USD, above the ${MAX_SPEND_USD} USD cap (lower --amount)`,
    );
  }
  return usd;
}

/** 125% of `amountIn`, rounded up: the overpaid send of check (1). */
export function overpayAmount(amountIn: bigint): bigint {
  return (amountIn * 125n + 99n) / 100n;
}

/** Check (1b): the first send is half (rounded down), the top-up the rest. */
export function splitUnderpay(amountIn: bigint): { first: bigint; rest: bigint } {
  const first = amountIn / 2n;
  return { first, rest: amountIn - first };
}

function positiveNumber(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : Number.NaN;
}

/**
 * Every spend of a run, from a dry EXACT_OUTPUT quote (`amountIn`, `amountInUsd` for one payment)
 * and the NEAR price. Swap values carry PRICE_MARGIN; `totalUsd` is what the cap is checked on.
 */
export function buildSpendPlan(p: {
  amountInUsd: string | undefined;
  amountIn: string;
  originAsset: string;
  nearUsd: string | undefined;
}): { text: string; totalUsd: number; fixedUsd: number; originUnits: bigint; nearYocto: bigint } {
  const oneUsd = positiveNumber(p.amountInUsd);
  if (Number.isNaN(oneUsd)) {
    throw new UsageError('refusing to spend: the dry quote has no usable amountInUsd');
  }
  const nearUsd = positiveNumber(p.nearUsd);
  if (Number.isNaN(nearUsd)) {
    throw new UsageError(
      'refusing to spend: 1Click lists no NEAR price, so the plan cannot be capped',
    );
  }
  const amountIn = BigInt(p.amountIn);
  const overUsd = oneUsd * 1.25;
  const swapUsd = (overUsd + oneUsd + oneUsd) * PRICE_MARGIN;
  const nearYocto = STORAGE_DEPOSIT_NEAR * BigInt(PAYMENTS) + GAS_NEAR;
  const fixedUsd = (Number(nearYocto / 10n ** 18n) / 1e6) * nearUsd;
  const totalUsd = swapUsd + fixedUsd;
  const originUnits = overpayAmount(amountIn) + amountIn + amountIn;
  const text = [
    'Spend plan (every payment is delivered or refunded to your own intents balance; cleanup returns it):',
    `  - (1) overpay: ${overpayAmount(amountIn)} units of ${p.originAsset}, ${fmtUsd(overUsd)} USD`,
    `  - (1b) underpay + top-up: ${amountIn} units in two sends, ${fmtUsd(oneUsd)} USD`,
    `  - (2) late deposit: ${amountIn} units, ${fmtUsd(oneUsd)} USD (refunded, or swapped to you)`,
    `  - NEAR storage and gas: up to ${formatNear(nearYocto)} (${fmtUsd(fixedUsd)} USD): LOST`,
    `  - LOST in every payment: the appFees share to the fee account, 1Click's fee and the spread`,
    `  Total at risk, with a ${Math.round((PRICE_MARGIN - 1) * 100)}% price margin: ${fmtUsd(totalUsd)} USD (cap ${MAX_SPEND_USD} USD)`,
  ].join('\n');
  return { text, totalUsd, fixedUsd, originUnits, nearYocto };
}

/** Running total of what a run has committed; refuses any send that would pass the cap. */
export class SpendTracker {
  private spent: number;

  constructor(fixedUsd: number) {
    this.spent = fixedUsd;
  }

  get totalUsd(): number {
    return this.spent;
  }

  commit(usd: number, what: string): void {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new UsageError(`refusing to send ${what}: it cannot be priced in USD`);
    }
    if (this.spent + usd > MAX_SPEND_USD) {
      throw new UsageError(
        `refusing to send ${what}: ${fmtUsd(usd)} USD would bring the run to ${fmtUsd(this.spent + usd)} USD, above the ${MAX_SPEND_USD} USD cap`,
      );
    }
    this.spent += usd;
  }
}

/** Asks the operator to type CONFIRM_WORD. True only on exactly that word. */
export async function confirmSpend(
  totalUsd: number,
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  const answer = await ask(
    `Spend up to ${totalUsd.toFixed(2)} USD on mainnet? Type "${CONFIRM_WORD}" to go ahead: `,
  );
  return answer.trim() === CONFIRM_WORD;
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
  fail: (name: string, detail: string): never => {
    console.log(`FAIL: ${name}: ${detail}`);
    throw new CheckFailed(`${name}: ${detail}`);
  },
};

/** Runs `fn`; an exception becomes a FAIL and stops the run. */
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    report.pass(name, detail ?? '');
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

/** Commits a payment's USD value to the tracker (refuses past the cap). */
function commit(c: Ctx, q: QuoteResponse, fraction: number, what: string): void {
  c.tracker!.commit(positiveNumber(q.quote.amountInUsd) * fraction, what);
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
  const box: { final?: { s: StatusResponse; raw: string } } = {};

  await check('(1) EXACT_OUTPUT overpaid by 25%: 1Click settles', async () => {
    const q = await quote(c, quoteRequest(c.a, false), '(1) real quote');
    if (!q.quote.depositAddress) throw new Error('the real quote has no depositAddress');
    commit(c, q, 1.25, '(1) overpay');
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
  const final = box.final!;
  const s = final.s;

  await check(
    '(1) the recipient is credited exactly amount_out, as the watcher verifies it',
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
      if (r.verdict === 'short')
        throw new Error(`largest credit ${r.best} < amount_out ${required}`);
      if (r.verdict === 'more') {
        report.info(
          '(1) credit above amount_out',
          `${r.best} > ${required}: some excess was swapped`,
        );
      }
      return `credit ${r.best} for amount_out ${required} (${r.verdict})`;
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
      '(3) fee account intents deltas',
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
}

async function check1b(c: Ctx): Promise<void> {
  await check('(1b) a top-up to the same address before the deadline is accumulated', async () => {
    const q = await quote(c, quoteRequest(c.a, false), '(1b) real quote');
    const addr = q.quote.depositAddress;
    if (!addr) throw new Error('the real quote has no depositAddress');
    commit(c, q, 1, '(1b) underpay + top-up');
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
      report.info('(1b) INCOMPLETE_DEPOSIT not seen', err.message);
      return null;
    });
    if (mid) {
      report.info('(5) raw 1Click status after an underpay', clip(mid.raw));
      report.info(
        '(b) after the first half',
        `depositedAmount=${mid.s.swapDetails.depositedAmount ?? '(absent)'} originChainTxHashes=${mid.s.swapDetails.originChainTxHashes.map((h) => h.hash).join(', ')}`,
      );
      if (mid.s.status !== 'INCOMPLETE_DEPOSIT' && mid.s.status !== 'PENDING_DEPOSIT') {
        throw new Error(`after the first half 1Click reported ${mid.s.status}: no top-up window`);
      }
    }
    const h2 = await fund(c, addr, rest, '(1b) top-up');
    const end = await waitFor(c, addr, '(1b) after the top-up', (s) =>
      ['SUCCESS', 'REFUNDED', 'FAILED'].includes(s.status),
    );
    const deposited = end.s.swapDetails.depositedAmount;
    const seen = end.s.swapDetails.originChainTxHashes.map((h) => h.hash);
    report.info(
      '(b) depositedAmount vs origin tx hashes',
      `depositedAmount=${deposited ?? '(absent)'} (sent ${first} + ${rest} = ${first + rest}); hashes listed: ${seen.join(', ') || '(none)'}; first ${seen.includes(h1) ? 'listed' : 'NOT listed'}, top-up ${seen.includes(h2) ? 'listed' : 'NOT listed'}`,
    );
    if (end.s.status !== 'SUCCESS') {
      throw new Error(
        `ended ${end.s.status}: 1Click did not accumulate the top-up; keep CHECKOUT_TOPUP_ENABLED unset in live`,
      );
    }
    const { credits } = await settlementCredits(c, end.s, '(1b)');
    const r = summarizeCredits(credits, BigInt(c.a.amountOut));
    if (r.verdict === 'none' || r.verdict === 'short') {
      throw new Error(`SUCCESS but no settlement credit ≥ amount_out (${r.verdict} ${r.best})`);
    }
    return 'accumulated and settled: CHECKOUT_TOPUP_ENABLED=true is safe in live';
  });
}

async function check2(c: Ctx): Promise<void> {
  await check('(2) a deposit after the quote deadline is refunded or swapped', async () => {
    const q = await quote(c, quoteRequest(c.a, false, LATE_QUOTE_TTL_MS), '(2) real quote');
    const addr = q.quote.depositAddress;
    if (!addr) throw new Error('the real quote has no depositAddress');
    const deadline = new Date(q.quote.deadline ?? Date.now() + LATE_QUOTE_TTL_MS).getTime();
    commit(c, q, 1, '(2) late deposit');
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
  const box: { dry?: QuoteResponse; nearUsd?: string } = {};
  await check('(c) the dry quote and token list parse with oneclick/http.ts', async () => {
    box.dry = await quote(c, quoteRequest(c.a, true), '(c) dry quote');
    const tokens = await c.oneclick.tokens();
    box.nearUsd = tokens.find((t) => t.assetId === WNEAR)?.priceUsd;
    return `${tokens.length} tokens; ${WNEAR} at ${box.nearUsd ?? '(no price)'} USD`;
  });
  const plan = buildSpendPlan({
    amountInUsd: box.dry!.quote.amountInUsd,
    amountIn: box.dry!.quote.amountIn,
    originAsset: c.a.originAsset,
    nearUsd: box.nearUsd,
  });
  console.log(`\n${plan.text}\n`);
  assertPlanWithinCap(plan.totalUsd);

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

  if (!(await confirmSpend(plan.totalUsd, ask))) {
    throw new UsageError('not confirmed; nothing was spent');
  }
  c.tracker = new SpendTracker(plan.fixedUsd);

  await check1(c);
  await check1b(c);
  await check2(c);
  console.log(`\nALL CHECKS PASSED (committed about ${fmtUsd(c.tracker.totalUsd)} USD)`);
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
  if (!(await confirmSpend(0.01, ask))) throw new UsageError('not confirmed; nothing was sent');
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
