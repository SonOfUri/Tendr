// Shopper-side checkout: the shopper-safe session view, the token list, quotes, deposit-tx submit,
// the refund-contact email and the test-mode deposit simulator. Every function acts on exactly the
// session the client secret authenticated (`ctx.sessionId`), through the request's scoped client.
//
// Quotes: the refund address (connected wallet, or the optional manual-send refund address) is
// format-checked for the origin chain and screened first; a sanctions hit is 403
// WALLET_NOT_ALLOWED before 1Click is called. Then dry → real (pricing.ts), the merchant-pays
// post-check (`assertWithinTarget`, one retry on QUOTE_PRICE_MOVED), the minimum, and the new
// `quotes` row replaces (supersedes) the session's previous one in one transaction.
import { Prisma } from '@prisma/client';
import { SMALL_OVERPAY_USD, feePayerFromDb, gasPayerFromDb, type FeePayer } from '@tendr/contracts';
import { z } from 'zod';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { toJsonDecimal } from '../lib/serialize.js';
import { isValidAddress } from './address-format.js';
import { gasEstimateUsd } from './gas-estimates.js';
import {
  OneClickError,
  SIMULATE_SCENARIOS,
  feeAccountFor,
  providerFor,
  simulatedOneClick,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
} from './oneclick/index.js';
import { assertWithinMinimum, assertWithinTarget, buildQuoteRequests } from './pricing.js';
import { emailWaitingReturns, shopperRefunds } from './refunds.js';
import { screenAddress } from './screening.js';
import type { CheckoutCtx } from './sessions.js';
import { tokenInfo, tokenList } from './tokens.js';
import { markSessionViewed, topupEnabled, watcherNow } from './watcher.js';

/** The tenant plus the one session the client secret opened. */
export type ShopperCtx = CheckoutCtx & { sessionId: string };

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export const QuoteInputSchema = z
  .object({
    origin_asset: z.string().min(1).max(200),
    /** Connected wallet, or the optional manual-send refund address. */
    refund_address: z.string().trim().min(1).max(128).optional(),
    /** The refund address's chain; when given it must be the origin asset's chain. */
    refund_chain: z.string().min(1).max(64).optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof QuoteInputSchema>;

export const DepositInputSchema = z
  .object({
    tx_hash: z.string().regex(/^[\x21-\x7e]{1,256}$/, 'must be a transaction hash'),
    /** The quote the shopper paid: the hash is only ever attached to that quote. */
    quote_id: z.string().regex(/^quo_[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a quote id'),
  })
  .strict();

export const EmailInputSchema = z.object({ email: z.string().trim().max(254).email() }).strict();

export const SimulateInputSchema = z
  .object({
    scenario: z.enum(SIMULATE_SCENARIOS),
    /** Overrides the simulated sender (e.g. a sanctioned address). */
    sender_address: z.string().min(1).max(128).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const sessionExpired = () =>
  new AppError('SESSION_EXPIRED', 'This checkout has expired; return to the store', 409);

/** Maps a 1Click failure to the API's envelope; anything else is rethrown. */
function providerError(err: unknown): never {
  if (err instanceof OneClickError) {
    log('warn', '1Click call failed', { code: err.code, status: err.status, msg: err.message });
    if (err.code === 'UNSUPPORTED_ASSET') {
      throw new AppError('UNSUPPORTED_ASSET', 'This token is not supported', 400);
    }
    if (err.code === 'NOT_FOUND') throw notFound('Deposit address not found');
    if (err.code === 'INVALID_STATE' || err.code === 'BUSY') throw conflict(err.message);
    // 401/403 are our credentials failing, not the shopper's request: the provider is unusable.
    if (
      err.status !== null &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 401 &&
      err.status !== 403
    ) {
      throw new AppError('VALIDATION_ERROR', 'The swap provider rejected this request', 400, {
        provider_code: err.code,
      });
    }
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'The swap provider is unavailable; try again shortly',
      503,
    );
  }
  throw err;
}

async function loadSession(ctx: ShopperCtx) {
  const s = await ctx.db.session.findFirst({ where: { id: ctx.sessionId } });
  // The gateway resolved this session; it can only vanish if the tenant changed. Fail closed.
  if (!s) throw notFound('Session not found');
  return s;
}

type SessionRow = Awaited<ReturnType<typeof loadSession>>;

/** SESSION_EXPIRED when the session's lifetime is over; CONFLICT when it is past taking quotes. */
function assertOpen(s: { status: string; expiresAt: Date }, now: Date): void {
  if (s.status === 'EXPIRED' || s.expiresAt.getTime() <= now.getTime()) throw sessionExpired();
  if (s.status !== 'PENDING_DEPOSIT') {
    throw conflict('This checkout is no longer taking new payments', { status: s.status });
  }
}

/** The session's live (not superseded) quote, newest first. */
function currentQuote(ctx: ShopperCtx) {
  return ctx.db.quote.findFirst({
    where: { sessionId: ctx.sessionId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

type QuoteRow = NonNullable<Awaited<ReturnType<typeof currentQuote>>>;

/** "Network & service fee" = what the shopper sends minus what the store receives (USD). */
function feeLines(feePayer: FeePayer, q: Pick<QuoteRow, 'amountInUsd' | 'amountOutUsd'>) {
  if (feePayer !== 'shopper' || !q.amountInUsd || !q.amountOutUsd) return [];
  const fee = q.amountInUsd.minus(q.amountOutUsd);
  if (fee.lte(0)) return [];
  return [
    {
      kind: 'network_and_service' as const,
      label: 'Network & service fee',
      // Rounded up to the cent: never understate what the shopper pays.
      amount_usd: fee.toDecimalPlaces(2, Prisma.Decimal.ROUND_UP).toFixed(2),
    },
  ];
}

function quoteView(q: QuoteRow, feePayer: FeePayer, now = new Date()) {
  const direct = q.refundType === 'ORIGIN_CHAIN';
  return {
    id: q.id,
    origin_asset: q.originAssetId,
    deposit_address: q.depositAddress,
    /** Exact base units the shopper must send. */
    amount_in: q.amountIn.toFixed(),
    amount_in_usd: toJsonDecimal(q.amountInUsd),
    deadline: q.deadline.toISOString(),
    expired: q.deadline.getTime() <= now.getTime(),
    /**
     * `origin_chain`: 1Click returns money straight to `refund_address`. `store`: returns go
     * through the store (the merchant account is never named here).
     */
    refund: direct ? ('origin_chain' as const) : ('store' as const),
    refund_address: direct ? q.refundTo : null,
    fee_lines: feeLines(feePayer, q),
    /** Show the notice that leftovers worth under `small_overpay_usd` are not returned. */
    small_overpay_notice: true,
    small_overpay_usd: SMALL_OVERPAY_USD,
  };
}

/** The shopper-facing state of a payment (no screening or settlement internals). */
function shopperState(p: {
  status: string;
  isLate: boolean;
  oneclickStatus: string | null;
}): string {
  if (p.isLate) return 'late';
  if (p.status === 'PROCESSING' && p.oneclickStatus === 'INCOMPLETE_DEPOSIT') return 'underpaid';
  switch (p.status) {
    case 'DETECTED':
      return 'detected';
    case 'PROCESSING':
    case 'SCREENING_PENDING':
      return 'converting';
    case 'SETTLED':
      return 'settled';
    case 'REFUNDING':
      return 'refunding';
    case 'REFUNDED':
      return 'refunded';
    case 'HELD':
      return 'held';
    default:
      return 'processing';
  }
}

async function storeInfo(ctx: ShopperCtx, s: SessionRow) {
  const [merchant, theme] = await Promise.all([
    ctx.db.merchant.findFirstOrThrow({ select: { name: true, checkoutDomains: true } }),
    ctx.db.checkoutTheme.findFirst({
      where: s.themeId
        ? { id: s.themeId, status: 'published' }
        : { isDefault: true, status: 'published' },
      select: { displayName: true, logoUrl: true },
    }),
  ]);
  return {
    display: { name: theme?.displayName ?? merchant.name, logo_url: theme?.logoUrl ?? null },
    checkoutDomains: [...merchant.checkoutDomains],
  };
}

/** Base units → a decimal string ("0.005"). */
function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

type PaymentRow = Awaited<ReturnType<ShopperCtx['db']['payment']['findMany']>>[number];

/**
 * The underpay top-up offer (spec "Changes" #8): while the underpaid payment's quote is live and
 * top-ups are enabled, "Send the remaining X to the same address". Null otherwise.
 */
async function topupOffer(ctx: ShopperCtx, payments: PaymentRow[], now: Date) {
  if (!topupEnabled(ctx.livemode)) return null;
  const p = payments.find(
    (x) => x.status === 'PROCESSING' && x.oneclickStatus === 'INCOMPLETE_DEPOSIT' && !x.isLate,
  );
  if (!p) return null;
  const q = await ctx.db.quote.findFirst({ where: { id: p.quoteId } });
  if (!q || q.deadline.getTime() <= now.getTime()) return null;
  const remaining = BigInt(q.amountIn.toFixed(0)) - BigInt(p.amountReceived.toFixed(0));
  if (remaining <= 0n) return null;
  let label = `${remaining.toString()} base units`;
  try {
    const t = await tokenInfo(ctx.livemode, q.originAssetId);
    label = `${formatUnits(remaining, t.decimals)} ${t.symbol}`;
  } catch {
    // The token list is unavailable: show base units.
  }
  return {
    payment_id: p.id,
    origin_asset: q.originAssetId,
    deposit_address: q.depositAddress,
    remaining_amount: remaining.toString(),
    deadline: q.deadline.toISOString(),
    message: `Send the remaining ${label} to the same address`,
  };
}

/** Whether a refund is waiting on the shopper and the store gave no email. */
async function needsEmail(ctx: ShopperCtx, s: SessionRow): Promise<boolean> {
  if (s.customerEmail) return false;
  const waiting = await ctx.db.refund.count({
    where: { needsAddress: true, payment: { sessionId: s.id } },
  });
  return waiting > 0;
}

/**
 * When a deposit was last reported for this session that the watcher has not accounted for yet
 * (C32-C34): a quote counts when its `depositTxSubmittedAt` is later than its newest payment row's
 * `createdAt`, or it has no payment row. A reported deposit the watcher already recorded stops
 * counting (a reopened session is not stuck behind it); a second report on the same quote after
 * that counts again. A superseded quote with a payment row never counts (C35): it takes no new
 * reports, and the reopen that superseded it already accounted for its deposit, even when a report
 * landed after the watcher recorded it. Prisma can't compare columns, so this is computed here.
 */
async function depositSubmittedAt(ctx: ShopperCtx, sessionId: string): Promise<Date | null> {
  const quotes = await ctx.db.quote.findMany({
    where: { sessionId, depositTxSubmittedAt: { not: null } },
    select: {
      depositTxSubmittedAt: true,
      supersededAt: true,
      payments: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  let latest: Date | null = null;
  for (const q of quotes) {
    const at = q.depositTxSubmittedAt!;
    const newest = q.payments[0]?.createdAt;
    if (newest && q.supersededAt) continue;
    if (newest && at.getTime() <= newest.getTime()) continue;
    if (!latest || at.getTime() > latest.getTime()) latest = at;
  }
  return latest;
}

/**
 * The shopper-safe view: merchant display name and logo, amount, status, expiry, the current quote
 * and payments with shopper-facing states. Never merchant ids, account ids, metadata, the external
 * reference or other sessions.
 */
export async function shopperSessionView(ctx: ShopperCtx) {
  const s = await loadSession(ctx);
  // The page is open: the watcher polls this session's addresses every 5 s for a minute.
  await markSessionViewed(s.id);
  const feePayer = feePayerFromDb(s.feePayer);
  const [store, quote, payments, emailNeeded, refunds, submitted] = await Promise.all([
    storeInfo(ctx, s),
    currentQuote(ctx),
    ctx.db.payment.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: 'asc' } }),
    needsEmail(ctx, s),
    shopperRefunds(ctx),
    depositSubmittedAt(ctx, s.id),
  ]);
  return {
    id: s.id,
    livemode: s.livemode,
    merchant: store.display,
    /** Origins allowed to frame the page: the embed bridge posts only to one of these. */
    checkout_domains: store.checkoutDomains,
    amount: s.amount.toFixed(),
    amount_currency: s.amountCurrency,
    settlement_asset: s.destAsset,
    status: s.status,
    expires_at: s.expiresAt.toISOString(),
    fee_payer: feePayer,
    gas_payer: gasPayerFromDb(s.gasSponsor),
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    quote: quote ? quoteView(quote, feePayer) : null,
    payments: payments.map((p) => ({
      id: p.id,
      state: shopperState(p),
      amount_received: toJsonDecimal(p.amountReceived),
      overpaid_amount: toJsonDecimal(p.overpaidAmount),
      refunded_amount: toJsonDecimal(p.refundedAmount),
      kept_small_overpayment: p.keptSmallOverpayment,
      /**
       * The extra paid was worth under $1 and stays with the store. Neutral by design (C42): the
       * shopper never learns a return's reason (a held payment's would reveal the screening).
       */
      kept_extra: p.keptSmallReasons.includes('overpaid'),
      origin_tx_hash: p.originTxHash,
      created_at: p.createdAt.toISOString(),
    })),
    /** Returns to the shopper; one with `needs_address` waits for "Tell us where to send it". */
    refunds,
    needs_email: emailNeeded,
    /** When a deposit transaction was last reported for this session (any quote), else null. */
    deposit_submitted_at: submitted?.toISOString() ?? null,
    topup: await topupOffer(ctx, payments, watcherNow()),
  };
}

/** Tokens most shoppers pay with, listed first (by symbol, in this order). */
const POPULAR_SYMBOLS = ['USDC', 'USDT', 'ETH', 'BTC', 'SOL', 'wNEAR', 'NEAR'];

/** The mode's 1Click tokens (cached 5 min), popular first, then by symbol and chain. */
export async function shopperTokens(livemode: boolean) {
  const tokens = [...(await tokenList(livemode)).values()];
  const rank = (symbol: string) => {
    const i = POPULAR_SYMBOLS.indexOf(symbol);
    return i === -1 ? POPULAR_SYMBOLS.length : i;
  };
  tokens.sort(
    (a, b) =>
      rank(a.symbol) - rank(b.symbol) ||
      a.symbol.localeCompare(b.symbol) ||
      a.blockchain.localeCompare(b.blockchain),
  );
  return {
    tokens: tokens.map((t) => ({
      asset_id: t.assetId,
      symbol: t.symbol,
      blockchain: t.blockchain,
      decimals: t.decimals,
      price_usd: t.priceUsd ?? null,
      popular: rank(t.symbol) < POPULAR_SYMBOLS.length,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------------------------

/** Merchant-pays quotes are retried once when the price moved between dry and real. */
const PRICE_MOVED_ATTEMPTS = 2;

/**
 * Prices and allocates a deposit address for the session, replacing its previous quote.
 * Errors: SESSION_EXPIRED / CONFLICT (409) for a closed session, VALIDATION_ERROR (400) for a
 * malformed refund address, WALLET_NOT_ALLOWED (403) on a sanctions hit, UNSUPPORTED_ASSET (400),
 * QUOTE_TOO_SMALL (400), QUOTE_PRICE_MOVED (409) after the retry, PROVIDER_UNAVAILABLE (503).
 */
export async function createQuote(ctx: ShopperCtx, input: QuoteInput) {
  const s = await loadSession(ctx);
  assertOpen(s, new Date());
  // Before any screening or 1Click call; re-checked under the session lock below.
  await assertQuotable(ctx.db, ctx, s.id, new Date());

  const [origin, settlement] = await Promise.all([
    tokenInfo(ctx.livemode, input.origin_asset),
    tokenInfo(ctx.livemode, s.destAsset),
  ]);

  let refundAddress = input.refund_address;
  if (
    input.refund_chain !== undefined &&
    input.refund_chain.toLowerCase() !== origin.blockchain.toLowerCase()
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `refund_chain must be the chain of the token you pay with (${origin.blockchain})`,
      400,
      { field: 'refund_chain' },
    );
  }
  if (refundAddress !== undefined) {
    if (!isValidAddress(origin.blockchain, refundAddress)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `refund_address is not a valid ${origin.blockchain} address`,
        400,
        { field: 'refund_address' },
      );
    }
    const { decision } = await screenAddress(ctx, {
      sessionId: s.id,
      address: refundAddress,
      chain: origin.blockchain,
    });
    if (decision === 'block') {
      throw new AppError('WALLET_NOT_ALLOWED', 'This wallet cannot be used for this payment', 403);
    }
    if (decision === 'unavailable') {
      // Never hand 1Click an unscreened address as its direct `refundTo` (I-3): it would return
      // underpay, overpay excess and late deposits straight there, past every Tendr gate. Quote
      // as for a manual send instead (refundType INTENTS): returns go through the store path,
      // which screens every destination right before drafting.
      log('warn', 'quote: refund address screening unavailable; refunds go through the store', {
        sessionId: s.id,
      });
      refundAddress = undefined;
    }
  }

  // The session pinned its recipient and recipient type at creation: the merchant account
  // (INTENTS) or the saved payout address (DESTINATION_CHAIN, wallet mode). Without a refund
  // address, returns go to the merchant intents account the session pinned; that account (and
  // an INTENTS recipient) must still be the store's active account.
  const recipientType: QuoteRequest['recipientType'] = s.recipientType;
  const intentsAccount = s.recipientType === 'INTENTS' ? s.recipient : s.intentsAccount;
  const needsAccount = recipientType === 'INTENTS' || refundAddress === undefined;
  if (needsAccount) {
    const active = intentsAccount
      ? await ctx.db.merchantAccount.findFirst({
          where: { nearAccountId: intentsAccount, status: 'active' },
          select: { id: true },
        })
      : null;
    if (!active) {
      throw new AppError('ACCOUNT_NOT_READY', 'The store cannot take payments right now', 409);
    }
  }
  const refundTo = refundAddress ?? intentsAccount!;
  const refundType: QuoteRequest['refundType'] = refundAddress ? 'ORIGIN_CHAIN' : 'INTENTS';
  const feePayer = feePayerFromDb(s.feePayer);
  const provider = providerFor(ctx.livemode);

  let real: QuoteResponse | null = null;
  let realReq: QuoteRequest | null = null;
  for (let attempt = 1; attempt <= PRICE_MOVED_ATTEMPTS && !real; attempt++) {
    const reqs = buildQuoteRequests({
      orderAmount: s.amount,
      amountCurrency: s.amountCurrency,
      settlementAsset: s.destAsset,
      settlementDecimals: settlement.decimals,
      originAsset: origin.assetId,
      originDecimals: origin.decimals,
      feeBps: s.feeBps,
      feePayer,
      gasPayer: gasPayerFromDb(s.gasSponsor),
      gasEstimateUsd: gasEstimateUsd(origin.blockchain),
      gasMaxUsd: s.gasMaxUsd,
      recipient: s.recipient,
      recipientType,
      refundTo,
      refundType,
      feeAccount: feeAccountFor(ctx.livemode),
      sessionExpiresAt: s.expiresAt,
    });
    try {
      const dry = await provider.quote(reqs.dry);
      const req = reqs.real(dry);
      const res = await provider.quote(req);
      if (feePayer === 'merchant') assertWithinTarget(res, reqs.targetUsd);
      real = res;
      realReq = req;
    } catch (err) {
      if (
        err instanceof AppError &&
        err.code === 'QUOTE_PRICE_MOVED' &&
        attempt < PRICE_MOVED_ATTEMPTS
      ) {
        continue;
      }
      if (err instanceof AppError) throw err;
      providerError(err);
    }
  }
  if (!real || !realReq) throw new Error('unreachable: quote loop ended without a quote');
  assertWithinMinimum(real);

  const depositAddress = real.quote.depositAddress;
  if (!depositAddress) {
    providerError(new OneClickError('Quote has no deposit address', null, 'BAD_RESPONSE'));
  }
  const requested = new Date(realReq.deadline);
  const returned = real.quote.deadline ? new Date(real.quote.deadline) : requested;
  const deadline = Number.isNaN(returned.getTime()) || returned > requested ? requested : returned;

  let writtenId = newId('quo');
  await tenantTransaction(ctx, async (tx, t) => {
    const tenant = { merchantId: t.merchantId, livemode: t.livemode };
    // Serialise quotes for this session and re-check it is still open.
    const locked = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
      SELECT status::text AS status, expires_at FROM sessions
      WHERE id = ${s.id} AND merchant_id = ${t.merchantId} AND livemode = ${t.livemode}
      FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Session not found');
    const now = new Date();
    assertOpen({ status: row.status, expiresAt: row.expires_at }, now);
    await assertQuotable(tx, t, s.id, now);

    await tx.quote.updateMany({
      where: { ...tenant, sessionId: s.id, supersededAt: null },
      data: { supersededAt: now },
    });
    const clash = await tx.quote.findFirst({
      where: { livemode: t.livemode, depositAddress },
      select: { id: true, sessionId: true, merchantId: true },
    });
    if (clash) {
      // 1Click handed back an address we already hold (the simulator does for an identical
      // request). Only this session's own quote may be revived; anything else is refused.
      if (clash.sessionId !== s.id || clash.merchantId !== t.merchantId) {
        throw conflict('The swap provider returned a deposit address already in use');
      }
      await tx.quote.updateMany({
        where: { ...tenant, id: clash.id },
        data: {
          supersededAt: null,
          amountIn: real.quote.amountIn,
          amountOut: real.quote.amountOut,
          amountInUsd: real.quote.amountInUsd,
          amountOutUsd: real.quote.amountOutUsd,
          refundTo,
          refundType,
          deadline,
          oneclickQuoteRef: real.correlationId,
        },
      });
      writtenId = clash.id;
      return;
    }
    await tx.quote.create({
      data: {
        id: writtenId,
        ...tenant,
        sessionId: s.id,
        originAssetId: origin.assetId,
        depositAddress,
        amountIn: real.quote.amountIn,
        amountOut: real.quote.amountOut,
        amountInUsd: real.quote.amountInUsd,
        amountOutUsd: real.quote.amountOutUsd,
        refundTo,
        refundType,
        deadline,
        oneclickQuoteRef: real.correlationId,
      },
    });
  });

  // The row this request wrote (a concurrent quote may already have superseded it).
  const stored = await ctx.db.quote.findFirstOrThrow({ where: { id: writtenId } });
  return quoteView(stored, feePayer);
}

/** Lifetime cap on quotes per session (each allocates a deposit address and calls 1Click). */
export const MAX_QUOTES_PER_SESSION = 30;

type QuoteReader = Pick<Prisma.TransactionClient, 'quote'> | ShopperCtx['db'];

/**
 * RATE_LIMITED (429) once the session has used its lifetime quota; DEPOSIT_IN_PROGRESS (409)
 * while the current quote has a reported deposit and its deadline has not passed (a new quote
 * would replace the address the money is on its way to). `db` is the scoped client or a
 * transaction client; reads are always filtered by the tenant.
 */
async function assertQuotable(
  db: QuoteReader,
  t: { merchantId: string; livemode: boolean },
  sessionId: string,
  now: Date,
): Promise<void> {
  const where = { merchantId: t.merchantId, livemode: t.livemode, sessionId };
  const quotes = db.quote as Prisma.TransactionClient['quote'];
  const [count, current] = await Promise.all([
    quotes.count({ where }),
    quotes.findFirst({
      where: { ...where, supersededAt: null },
      orderBy: { createdAt: 'desc' },
      select: { depositTxSubmittedAt: true, deadline: true },
    }),
  ]);
  if (current?.depositTxSubmittedAt && current.deadline.getTime() > now.getTime()) {
    throw new AppError(
      'DEPOSIT_IN_PROGRESS',
      'Your payment is on its way; wait for it before requesting a new quote',
      409,
    );
  }
  if (count >= MAX_QUOTES_PER_SESSION) {
    throw new AppError('RATE_LIMITED', 'Too many quotes for this checkout', 429, {
      max_quotes: MAX_QUOTES_PER_SESSION,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Deposit submit, email, simulate
// ---------------------------------------------------------------------------------------------

async function requireQuote(ctx: ShopperCtx) {
  const q = await currentQuote(ctx);
  if (!q) throw conflict('Request a quote first');
  return q;
}

/** Session statuses in which a deposit for the current quote may still be reported. */
const DEPOSIT_OPEN_STATUSES = new Set(['PENDING_DEPOSIT', 'PROCESSING']);

/**
 * Tells 1Click about the shopper's deposit transaction for the current quote and records it on
 * the quote (which blocks re-quoting until the quote's deadline). Refused with SESSION_EXPIRED
 * past the session's lifetime, CONFLICT (409) when the session is past taking payments or the
 * quote's deadline has passed, and QUOTE_MISMATCH (409) when `quoteId` is not the current quote:
 * a hash is never re-attached to a quote other than the one it paid (C32).
 */
export async function submitDeposit(
  ctx: ShopperCtx,
  txHash: string,
  quoteId: string,
): Promise<void> {
  const s = await loadSession(ctx);
  const now = new Date();
  if (s.status === 'EXPIRED' || s.expiresAt.getTime() <= now.getTime()) throw sessionExpired();
  if (!DEPOSIT_OPEN_STATUSES.has(s.status)) {
    throw conflict('This checkout is no longer taking payments', { status: s.status });
  }
  const q = await requireQuote(ctx);
  if (q.id !== quoteId) {
    throw new AppError(
      'QUOTE_MISMATCH',
      'This transaction was for a different quote than the current one',
      409,
    );
  }
  if (q.deadline.getTime() <= now.getTime()) {
    throw conflict('This quote has expired; request a new one');
  }
  // Recorded first: a deposit may be on its way even if 1Click's acknowledgement fails.
  await ctx.db.quote.updateMany({
    where: { id: q.id },
    data: { depositTxHash: txHash, depositTxSubmittedAt: now },
  });
  try {
    await providerFor(ctx.livemode).submitDeposit(txHash, q.depositAddress);
  } catch (err) {
    providerError(err);
  }
}

/** Stores the shopper's email; only accepted while a refund needs it and the store gave none. */
export async function setShopperEmail(ctx: ShopperCtx, email: string): Promise<void> {
  const s = await loadSession(ctx);
  if (!(await needsEmail(ctx, s))) throw conflict('No email is needed for this checkout');
  const { count } = await ctx.db.session.updateMany({
    where: { id: s.id, customerEmail: null },
    data: { customerEmail: email.toLowerCase() },
  });
  // The email is for refund contact: send the return-address link now — only when this call set
  // it (a concurrent call that lost the race must not mail again, or mail a different address).
  if (count > 0) await emailWaitingReturns(ctx);
}

/**
 * Test mode only: simulates the shopper's deposit to the current quote. 404 for a live session,
 * whatever the environment (in production only test-mode sessions reach the simulator).
 */
export async function simulateDeposit(
  ctx: ShopperCtx,
  input: z.infer<typeof SimulateInputSchema>,
): Promise<StatusResponse> {
  // Production refuses everything but test-mode sessions, which is exactly this check.
  if (ctx.livemode) throw notFound();
  const q = await requireQuote(ctx);
  try {
    return await simulatedOneClick().simulate(q.depositAddress, input.scenario, {
      ...(input.sender_address ? { senderAddress: input.sender_address } : {}),
    });
  } catch (err) {
    return providerError(err);
  }
}
