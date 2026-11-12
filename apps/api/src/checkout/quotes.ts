import { env } from '../env.js';
import { usesTidepool } from '../lib/testnet.js';
// Shopper-side checkout: the shopper-safe session view, the token list, quotes, deposit-tx submit,
// the refund-contact email and the test-mode deposit simulator. Every function acts on exactly the
// session the client secret authenticated (`ctx.sessionId`), through the request's scoped client.
//
// Quotes: the refund address (connected wallet, or the optional manual-send refund address) is
// format-checked for the origin chain and screened first; a sanctions hit is 403
// WALLET_NOT_ALLOWED before 1Click is called. Then dry → real (pricing.ts), the merchant-pays
// post-check (`assertWithinTarget`, one retry on QUOTE_PRICE_MOVED), the minimum, and the new
// `quotes` row replaces (supersedes) the session's previous one in one transaction.
//
// Network fee (project 5a): the quote plans who pays the network fee (`gas/quote-fee.ts`). A
// merchant-sponsored fee is reserved on the merchant's budget in the quote's transaction and taken
// from the merchant's proceeds (pricing.ts `merchantDeductionUsd`); a reservation refused there
// (a concurrent payment took the budget) re-prices the quote with the shopper paying. Replacing a
// quote releases its reservation.
import { Prisma } from '@prisma/client';
import {
  FeeModeSchema,
  GaslessMethodSchema,
  LineItemSchema,
  SESSION_TTL_MS,
  SMALL_OVERPAY_USD,
  feePayerFromDb,
  gasPayerFromDb,
  maskAddressLike,
  type FeePayer,
} from '@tendr/contracts';
import { z } from 'zod';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { sha256 } from '../lib/crypto.js';
import { reserveBudget } from '../gas/budget.js';
import { releaseReplacedHold } from '../relayer/submissions.js';
import {
  gasProvider,
  networkFeeView,
  planColumns,
  planNetworkFee,
  type NetworkFeePlan,
} from '../gas/quote-fee.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { linkUrls } from '../payment-links/links.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { toJsonDecimal } from '../lib/serialize.js';
import { familyOf, relayerFor } from '../relayer/index.js';
import { gaslessToken } from '../relayer/evm/tokens.js';
import { nearGaslessToken } from '../relayer/near-meta.js';
import { solanaGaslessToken } from '../relayer/solana-tx.js';
import { tronGaslessToken } from '../relayer/tron.js';
import { chainFamily, isValidAddress } from './address-format.js';
import { quotesWithRelayInFlight } from './in-flight.js';
import {
  OneClickError,
  SIMULATE_SCENARIOS,
  feeAccountFor,
  providerFor,
  simulatedOneClick,
  type QuoteRequest,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
} from './oneclick/index.js';
import {
  assertOutputWithinTarget,
  assertWithinMinimum,
  assertWithinTarget,
  buildQuoteRequests,
} from './pricing.js';
import { emailWaitingReturns, shopperRefunds } from './refunds.js';
import { screenAddress } from './screening.js';
import { PUBLIC_LINK_SESSION_WHERE, publicLinkSession } from './session-refs.js';
import type { CheckoutCtx } from './sessions.js';
import { tokenInfo, tokenList } from './tokens.js';
import { resolveShopperTheme } from '../themes/resolve.js';
import { markSessionViewed, topupEnabled, watcherNow } from './watcher.js';

/** The tenant plus the one session the client secret opened. */
export type ShopperCtx = CheckoutCtx & { sessionId: string };

/** A cart line as the shopper sees it. */
export type ShopperLineItem = {
  name: string;
  quantity: number;
  unit_amount: string;
  description: string | null;
  image_url: string | null;
};

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
    /**
     * The connected wallet the shopper pays from (the gasless path). Without it the quote is for
     * a normal send (copy address): the shopper pays their own network fee.
     */
    wallet_address: z.string().trim().min(1).max(128).optional(),
    /** The gasless method the wallet can use on this chain; needs `wallet_address`. */
    gasless_method: GaslessMethodSchema.optional(),
    /**
     * When the shopper pays the fee: in the payment token (`token`, default with a gasless method)
     * or the chain's coin (`native`, a normal wallet send).
     */
    fee_mode: FeeModeSchema.optional(),
  })
  .strict()
  .refine((v) => v.gasless_method === undefined || v.wallet_address !== undefined, {
    message: 'gasless_method needs wallet_address',
    path: ['wallet_address'],
  });
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
    where: {
      sessionId: ctx.sessionId,
      supersededAt: null,
      ...(ctx.livemode
        ? {}
        : usesTidepool(false)
          ? { testProvider: 'tidepool' }
          : { OR: [{ testProvider: null }, { testProvider: 'simulated' }] }),
    },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

type QuoteRow = NonNullable<Awaited<ReturnType<typeof currentQuote>>>;

/**
 * "Network & service fee" = what the shopper sends minus what the store receives (USD). When the
 * store gives up part of its output for the network (a sponsored fee or an integrator hook
 * estimate, `network_fee_bps` > 0), the line is what the shopper sends minus the order total
 * instead: the store's deduction is never the shopper's fee.
 */
function feeLines(
  feePayer: FeePayer,
  q: Pick<QuoteRow, 'amountInUsd' | 'amountOutUsd' | 'networkFeeBps'>,
  orderUsd: Prisma.Decimal,
) {
  if (feePayer !== 'shopper' || !q.amountInUsd || !q.amountOutUsd) return [];
  const fee = q.amountInUsd.minus(q.networkFeeBps > 0 ? orderUsd : q.amountOutUsd);
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

/** `orderUsd`: the session's order total (USD, or the settlement stablecoin 1:1). */
function quoteView(q: QuoteRow, feePayer: FeePayer, orderUsd: Prisma.Decimal, now = new Date()) {
  const direct = q.refundType === 'ORIGIN_CHAIN';
  const networkFee = networkFeeView(q, 'shopper');
  return {
    id: q.id,
    origin_asset: q.originAssetId,
    deposit_address: q.depositAddress,
    /** Exact base units the shopper must send (a token network fee is sent on top: `fee_amount`). */
    amount_in: q.amountIn.toFixed(),
    amount_in_usd: toJsonDecimal(q.amountInUsd),
    /** Who pays the network fee and how; null on quotes made before gasless payments. */
    network_fee: networkFee,
    fee_mode: networkFee?.fee_mode ?? null,
    /** Shopper pays in the token: base units of `origin_asset` sent in addition to `amount_in`. */
    fee_amount: networkFee?.fee_mode === 'token' ? networkFee.amount : null,
    deadline: q.deadline.toISOString(),
    expired: q.deadline.getTime() <= now.getTime(),
    /**
     * `origin_chain`: 1Click returns money straight to `refund_address`. `store`: returns go
     * through the store (the merchant account is never named here).
     */
    refund: direct ? ('origin_chain' as const) : ('store' as const),
    refund_address: direct ? q.refundTo : null,
    fee_lines: feeLines(feePayer, q, orderUsd),
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
    case 'PARTIALLY_REFUNDED': // the store refunded part of a paid order: still paid here
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
  const merchant = await ctx.db.merchant.findFirstOrThrow({
    select: { name: true, slug: true, checkoutDomains: true },
  });
  const theme = await resolveShopperTheme(ctx.db, {
    merchantId: ctx.merchantId,
    merchantName: merchant.name,
    themeId: s.themeId,
    livemode: ctx.livemode,
    kind: 'checkout',
  });
  return {
    name: merchant.name,
    theme,
    checkoutDomains: [...merchant.checkoutDomains],
    slug: merchant.slug,
  };
}

/**
 * The payment link a public-path session came from: its title and page (the "Back to …" link).
 * Null for a store-path session naming a link, whose way back is the store's own URLs.
 */
async function linkInfo(
  ctx: ShopperCtx,
  s: SessionRow,
  merchantSlug: string,
): Promise<{ title: string; url: string } | null> {
  if (!publicLinkSession(s) || !s.paymentLinkId) return null;
  const link = await ctx.db.paymentLink.findFirst({
    where: { id: s.paymentLinkId },
    select: { title: true, slug: true },
  });
  if (!link) return null;
  return {
    title: maskAddressLike(link.title),
    url: linkUrls(merchantSlug, link.slug, s.livemode).url,
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
 * The session's cart lines as the shopper sees them. Names and descriptions are masked when they
 * look like an address; an image shows only once Tendr has fetched and cached it (`ProductImage`
 * `ok`), otherwise null. Stored lines that no longer parse yield none: a page never fails on them.
 */
async function shopperLineItems(ctx: ShopperCtx, s: SessionRow): Promise<ShopperLineItem[]> {
  const parsed = LineItemSchema.array().safeParse(s.lineItems ?? []);
  if (!parsed.success) return [];
  const items = parsed.data;
  const hashes = [...new Set(items.flatMap((i) => (i.image_url ? [sha256(i.image_url)] : [])))];
  const cached = new Map<string, string>();
  if (hashes.length > 0) {
    const rows = await ctx.db.productImage.findMany({
      where: { urlHash: { in: hashes }, status: 'ok' },
      select: { urlHash: true, url: true },
    });
    for (const r of rows) if (r.url) cached.set(r.urlHash, r.url);
  }
  return items.map((i) => ({
    name: maskAddressLike(i.name),
    quantity: i.quantity,
    unit_amount: i.unit_amount,
    description: i.description ? maskAddressLike(i.description) : null,
    image_url: (i.image_url && cached.get(sha256(i.image_url))) || null,
  }));
}

/**
 * The shopper-safe view: the payee and the resolved theme, amount, status, expiry, the current quote
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
    test_provider: s.livemode ? null : env().TEST_PAYMENT_PROVIDER,
    /** The account's name (the payee); the shown store name and logo live in `theme`. */
    merchant: { name: store.name },
    /** The resolved theme: re-read on every view, so a republish shows on the next poll. */
    theme: store.theme,
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
    /** The payment link this session came from (title and page); null otherwise. */
    payment_link: await linkInfo(ctx, s, store.slug),
    /** Cart lines shown in the order summary. */
    line_items: await shopperLineItems(ctx, s),
    quote: quote ? quoteView(quote, feePayer, s.amount) : null,
    /** The current quote's network fee (who pays, how, why); null without a quote. */
    network_fee: quote ? networkFeeView(quote, 'shopper') : null,
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
  // Test mode's fixture is a small stand-in for quoting. Merge the live catalog so the asset
  // modal matches demo (same pattern as knownIntentsChains / settlement pickers).
  const lists = [tokenList(livemode)];
  if (
    !livemode &&
    !usesTidepool(livemode) &&
    process.env.NODE_ENV !== 'test' &&
    process.env.VITEST !== 'true'
  ) {
    lists.push(tokenList(true));
  }
  const loaded = await Promise.all(lists.map((list) => list.catch(() => null)));
  const byId = new Map<string, TokenInfo>();
  for (const list of loaded) {
    if (!list) continue;
    for (const [id, t] of list) {
      if (!byId.has(id)) byId.set(id, t);
    }
  }
  const tokens = [...byId.values()];
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
 * Live gasless is switched off (GASLESS_LIVE_ENABLED): a live quote asking for a gasless method
 * is refused before anything is planned, priced or reserved (no fee RPC, no sponsor decision, no
 * budget), so quotes never include a sponsored path. Test mode is unaffected.
 */
export function assertGaslessAvailable(
  livemode: boolean,
  chain: string,
  method: string | undefined,
): void {
  if (usesTidepool(livemode) && method)
    throw new AppError('GASLESS_NOT_AVAILABLE', 'Pay testnet network fees from your wallet', 409);
  if (!livemode || !method) return;
  const family = familyOf(chain);
  if (family && relayerFor(family, true) === null) {
    throw new AppError(
      'GASLESS_NOT_AVAILABLE',
      'Gasless payments are not available in live mode yet',
      409,
    );
  }
}

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
  await assertQuotable(
    prisma,
    { merchantId: ctx.merchantId, livemode: ctx.livemode },
    s.id,
    new Date(),
  );

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

  const walletAddress = input.wallet_address;
  if (walletAddress !== undefined && !isValidAddress(origin.blockchain, walletAddress)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `wallet_address is not a valid ${origin.blockchain} address`,
      400,
      { field: 'wallet_address' },
    );
  }
  // EVM: only allow-listed tokens are relayed or sponsored (no fee-on-transfer or rebasing tokens).
  const method = input.gasless_method;
  if (
    (method === 'eip3009' || method === 'permit' || method === 'paymaster') &&
    chainFamily(origin.blockchain) === 'evm' &&
    !gaslessToken(origin.blockchain, origin.assetId)?.methods.includes(method)
  ) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available for this token`, 400, {
      field: 'gasless_method',
    });
  }
  // Solana: only allow-listed SPL Token program mints (never native SOL, never Token-2022).
  if (
    method === 'kora' &&
    chainFamily(origin.blockchain) === 'solana' &&
    !solanaGaslessToken(origin.assetId)
  ) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available for this token`, 400, {
      field: 'gasless_method',
    });
  }
  // NEAR: only allow-listed NEP-141 USDC / USDT (never wNEAR).
  if (
    method === 'meta_tx' &&
    chainFamily(origin.blockchain) === 'near' &&
    !nearGaslessToken(origin.assetId)
  ) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available for this token`, 400, {
      field: 'gasless_method',
    });
  }
  // Tron: USDT-TRC20 only, through the forwarder (never TRX, never another TRC-20).
  if (
    method === 'forwarder' &&
    chainFamily(origin.blockchain) === 'tron' &&
    !tronGaslessToken(origin.assetId)
  ) {
    throw new AppError('VALIDATION_ERROR', `${method} is not available for this token`, 400, {
      field: 'gasless_method',
    });
  }
  assertGaslessAvailable(ctx.livemode, origin.blockchain, method);
  const planFor = (forceShopper?: NetworkFeePlan['reason']) =>
    planNetworkFee({
      livemode: ctx.livemode,
      merchantId: ctx.merchantId,
      session: s,
      origin,
      ...(walletAddress !== undefined ? { walletAddress } : {}),
      ...(input.gasless_method ? { method: input.gasless_method } : {}),
      ...(input.fee_mode ? { feeMode: input.fee_mode } : {}),
      ...(forceShopper ? { forceShopper } : {}),
    });

  let plan = await planFor();
  // A sponsored quote whose reservation is refused (a concurrent payment took the budget) is
  // re-priced once with the shopper paying.
  for (let pass = 1; pass <= 2; pass++) {
    const priced = await priceQuote(provider, {
      orderAmount: s.amount,
      amountCurrency: s.amountCurrency,
      settlementAsset: s.destAsset,
      settlementDecimals: settlement.decimals,
      originAsset: origin.assetId,
      originDecimals: origin.decimals,
      feeBps: s.feeBps,
      feePayer,
      merchantDeductionUsd: addUsd(plan.sponsoredUsd, plan.hookUsd),
      recipient: s.recipient,
      recipientType,
      refundTo,
      refundType,
      feeAccount: feeAccountFor(ctx.livemode),
      sessionExpiresAt: await pricingExpiry(ctx, s),
    });
    const writtenId = await storeQuote(ctx, s.id, origin, refundTo, refundType, priced, plan, {
      walletAddress: walletAddress ?? null,
    });
    if (writtenId) {
      // The row this request wrote (a concurrent quote may already have superseded it).
      const stored = await ctx.db.quote.findFirstOrThrow({ where: { id: writtenId } });
      return quoteView(stored, feePayer, s.amount);
    }
    if (pass < 2) plan = await planFor('budget');
  }
  throw new Error('unreachable: a shopper-paid quote never needs a reservation');
}

/**
 * The expiry a quote's deadline is bounded by. A public link session's first quote extends the
 * session to `createdAt + SESSION_TTL_MS` (storeQuote), so that quote is priced against the
 * extended expiry rather than the short unquoted one.
 */
async function pricingExpiry(ctx: ShopperCtx, s: SessionRow): Promise<Date> {
  if (!publicLinkSession(s)) return s.expiresAt;
  const quoted = await ctx.db.quote.count({ where: { sessionId: s.id } });
  if (quoted > 0) return s.expiresAt;
  const extended = new Date(s.createdAt.getTime() + SESSION_TTL_MS);
  return extended > s.expiresAt ? extended : s.expiresAt;
}

/** Sum of two USD decimal strings (exact, via Prisma.Decimal). */
function addUsd(a: string, b: string): string {
  return new Prisma.Decimal(a).plus(b).toFixed();
}

interface Priced {
  real: QuoteResponse;
  req: QuoteRequest;
  networkFeeBps: number;
  depositAddress: string;
  deadline: Date;
}

/**
 * Dry → real quote (pricing.ts), the QUOTE_PRICE_MOVED retry (merchant-pays send target, or the
 * sponsored shopper-pays merchant output), the minimum.
 */
async function priceQuote(
  provider: ReturnType<typeof providerFor>,
  pricing: Parameters<typeof buildQuoteRequests>[0],
): Promise<Priced> {
  let real: QuoteResponse | null = null;
  let realReq: QuoteRequest | null = null;
  let networkFeeBps = 0;
  for (let attempt = 1; attempt <= PRICE_MOVED_ATTEMPTS && !real; attempt++) {
    const reqs = buildQuoteRequests(pricing);
    networkFeeBps = reqs.networkFeeBps;
    try {
      const dry = await provider.quote(reqs.dry);
      const req = reqs.real(dry);
      const res = await provider.quote(req);
      if (pricing.feePayer === 'merchant') assertWithinTarget(res, reqs.targetUsd);
      if (reqs.expectedOutUsd) assertOutputWithinTarget(res, reqs.expectedOutUsd);
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
  return { real, req: realReq, networkFeeBps, depositAddress, deadline };
}

/**
 * Stores the quote (with the wallet it was made for: the only signer the relayer accepts),
 * superseding the session's previous one, in one transaction under the session lock. A
 * merchant-sponsored plan reserves its fee first; when the reservation is refused nothing is
 * stored (the transaction still commits, keeping `gas.budget_exhausted`) and null is returned.
 * Replaced quotes' reservations are released. Returns the id of the row written.
 */
async function storeQuote(
  ctx: ShopperCtx,
  sessionId: string,
  origin: { assetId: string; blockchain: string },
  refundTo: string,
  refundType: QuoteRequest['refundType'],
  priced: Priced,
  plan: NetworkFeePlan,
  extra: { walletAddress: string | null },
): Promise<string | null> {
  const { real, depositAddress, deadline } = priced;
  let writtenId: string | null = newId('quo');
  await tenantTransaction(ctx, async (tx, t) => {
    const tenant = { merchantId: t.merchantId, livemode: t.livemode };
    // Serialise quotes for this session and re-check it is still open.
    const locked = await tx.$queryRaw<{ status: string; expires_at: Date; created_at: Date }[]>`
      SELECT status::text AS status, expires_at, created_at FROM sessions
      WHERE id = ${sessionId} AND merchant_id = ${t.merchantId} AND livemode = ${t.livemode}
      FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Session not found');
    const now = new Date();
    assertOpen({ status: row.status, expiresAt: row.expires_at }, now);
    await assertQuotable(tx, t, sessionId, now);

    // Release every hold of the session's earlier quotes (current or superseded): gas a failed
    // relay of theirs spent is Tendr's loss. A relay still in flight keeps its hold until its
    // outcome (released at collection of another quote, or at session end).
    const held = await tx.gasSponsorship.findMany({
      where: { ...tenant, sessionId, reservationState: 'reserved' },
      select: { id: true },
    });
    for (const h of held) await releaseReplacedHold(tx, tenant, h.id, now);

    let gasSponsorshipId: string | null = null;
    if (plan.paidBy === 'merchant') {
      const reserved = await reserveBudget(tx, {
        ...tenant,
        sessionId,
        usd: plan.sponsoredUsd,
        at: now,
        chain: origin.blockchain,
        method: plan.method!,
        provider: gasProvider(origin.blockchain, plan.method!),
      });
      if (!reserved) {
        writtenId = null;
        return;
      }
      gasSponsorshipId = reserved.sponsorshipId;
    }
    const fee = {
      ...planColumns(plan, priced.networkFeeBps),
      gasSponsorshipId,
      walletAddress: extra.walletAddress,
    };

    // A session from a link's public page starts with a short expiry (LINK_UNQUOTED_TTL_MS); its
    // first quote extends it to the normal lifetime, counted from creation. Later quotes, and
    // store-path sessions (which carry an external_ref and the store's own expiry), are untouched.
    await tx.session.updateMany({
      where: {
        ...tenant,
        id: sessionId,
        ...PUBLIC_LINK_SESSION_WHERE,
        quotes: { none: {} },
      },
      data: { expiresAt: new Date(row.created_at.getTime() + SESSION_TTL_MS) },
    });
    await tx.quote.updateMany({
      where: { ...tenant, sessionId, supersededAt: null },
      data: { supersededAt: now },
    });
    const clash = await tx.quote.findFirst({
      where: { livemode: t.livemode, depositAddress },
      select: { id: true, sessionId: true, merchantId: true, testProvider: true },
    });
    if (clash) {
      // 1Click handed back an address we already hold (the simulator does for an identical
      // request). Only this session's own quote may be revived; anything else is refused.
      if (
        clash.sessionId !== sessionId ||
        clash.merchantId !== t.merchantId ||
        (!t.livemode && (clash.testProvider ?? 'simulated') !== env().TEST_PAYMENT_PROVIDER)
      ) {
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
          ...fee,
        },
      });
      writtenId = clash.id;
      return;
    }
    await tx.quote.create({
      data: {
        id: writtenId!,
        testProvider: t.livemode ? null : env().TEST_PAYMENT_PROVIDER,
        ...tenant,
        sessionId,
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
        ...fee,
      },
    });
  });
  return writtenId;
}

/** Lifetime cap on quotes per session (each allocates a deposit address and calls 1Click). */
export const MAX_QUOTES_PER_SESSION = 30;

/**
 * RATE_LIMITED (429) once the session has used its lifetime quota; DEPOSIT_IN_PROGRESS (409)
 * while the current quote has a reported deposit and its deadline has not passed (a new quote
 * would replace the address the money is on its way to), or while a gasless relay of it is
 * claimed or broadcast with no known outcome yet (final review I3: an unknown-outcome relay can
 * still land). `db` is the unscoped client or a transaction client; reads are always filtered by
 * the tenant.
 */
async function assertQuotable(
  db: Prisma.TransactionClient | typeof prisma,
  t: { merchantId: string; livemode: boolean },
  sessionId: string,
  now: Date,
): Promise<void> {
  const where = { merchantId: t.merchantId, livemode: t.livemode, sessionId };
  const quotes = db.quote as Prisma.TransactionClient['quote'];
  const [count, current, relaying] = await Promise.all([
    quotes.count({ where }),
    quotes.findFirst({
      where: { ...where, supersededAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, depositTxSubmittedAt: true, deadline: true },
    }),
    quotesWithRelayInFlight(db, t, sessionId),
  ]);
  if (
    current &&
    (current.depositTxSubmittedAt || relaying.has(current.id)) &&
    current.deadline.getTime() > now.getTime()
  ) {
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
  if (!ctx.livemode && (q.testProvider ?? 'simulated') !== env().TEST_PAYMENT_PROVIDER)
    throw conflict('This quote belongs to the previous Test provider. Open a new checkout.');
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
  if (ctx.livemode || usesTidepool(ctx.livemode)) throw notFound();
  const q = await requireQuote(ctx);
  try {
    return await simulatedOneClick().simulate(q.depositAddress, input.scenario, {
      ...(input.sender_address ? { senderAddress: input.sender_address } : {}),
    });
  } catch (err) {
    return providerError(err);
  }
}
