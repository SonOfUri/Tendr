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
import { screenAddress } from './screening.js';
import type { CheckoutCtx } from './sessions.js';
import { tokenInfo, tokenList } from './tokens.js';

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
  .object({ tx_hash: z.string().regex(/^[\x21-\x7e]{1,256}$/, 'must be a transaction hash') })
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
    if (err.status !== null && err.status >= 400 && err.status < 500) {
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
function shopperState(p: { status: string; isLate: boolean }): string {
  if (p.isLate) return 'late';
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

async function merchantDisplay(ctx: ShopperCtx, s: SessionRow) {
  const [merchant, theme] = await Promise.all([
    ctx.db.merchant.findFirstOrThrow({ select: { name: true } }),
    ctx.db.checkoutTheme.findFirst({
      where: s.themeId ? { id: s.themeId } : { isDefault: true, status: 'published' },
      select: { displayName: true, logoUrl: true },
    }),
  ]);
  return { name: theme?.displayName ?? merchant.name, logo_url: theme?.logoUrl ?? null };
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
 * The shopper-safe view: merchant display name and logo, amount, status, expiry, the current quote
 * and payments with shopper-facing states. Never merchant ids, account ids, metadata, the external
 * reference or other sessions.
 */
export async function shopperSessionView(ctx: ShopperCtx) {
  const s = await loadSession(ctx);
  const feePayer = feePayerFromDb(s.feePayer);
  const [merchant, quote, payments, emailNeeded] = await Promise.all([
    merchantDisplay(ctx, s),
    currentQuote(ctx),
    ctx.db.payment.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: 'asc' } }),
    needsEmail(ctx, s),
  ]);
  return {
    id: s.id,
    livemode: s.livemode,
    merchant,
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
      origin_tx_hash: p.originTxHash,
      created_at: p.createdAt.toISOString(),
    })),
    needs_email: emailNeeded,
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

  const [origin, settlement] = await Promise.all([
    tokenInfo(ctx.livemode, input.origin_asset),
    tokenInfo(ctx.livemode, s.destAsset),
  ]);

  const refundAddress = input.refund_address;
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
      // Allowed: every sender is screened again when its deposit is detected.
      log('warn', 'quote: refund address screening unavailable; quoting anyway', {
        sessionId: s.id,
      });
    }
  }

  const account = await ctx.db.merchantAccount.findFirst({
    where: { status: 'active' },
    select: { nearAccountId: true },
  });
  if (!account) {
    throw new AppError('ACCOUNT_NOT_READY', 'The store cannot take payments right now', 409);
  }
  // The session pinned its recipient at creation: the merchant account (intents) or the saved
  // payout address (wallet mode).
  const recipientType: QuoteRequest['recipientType'] =
    s.recipient === account.nearAccountId ? 'INTENTS' : 'DESTINATION_CHAIN';
  const refundTo = refundAddress ?? account.nearAccountId;
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

  const id = newId('quo');
  await tenantTransaction(ctx, async (tx, t) => {
    const tenant = { merchantId: t.merchantId, livemode: t.livemode };
    // Serialise quotes for this session and re-check it is still open.
    const locked = await tx.$queryRaw<{ status: string; expires_at: Date }[]>`
      SELECT status::text AS status, expires_at FROM sessions
      WHERE id = ${s.id} AND merchant_id = ${t.merchantId} AND livemode = ${t.livemode}
      FOR UPDATE`;
    const row = locked[0];
    if (!row) throw notFound('Session not found');
    assertOpen({ status: row.status, expiresAt: row.expires_at }, new Date());

    const now = new Date();
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
      return;
    }
    await tx.quote.create({
      data: {
        id,
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

  const stored = await currentQuote(ctx);
  if (!stored) throw new Error('quote vanished after insert');
  return quoteView(stored, feePayer);
}

// ---------------------------------------------------------------------------------------------
// Deposit submit, email, simulate
// ---------------------------------------------------------------------------------------------

async function requireQuote(ctx: ShopperCtx) {
  const q = await currentQuote(ctx);
  if (!q) throw conflict('Request a quote first');
  return q;
}

/** Tells 1Click about the shopper's deposit transaction for the current quote. */
export async function submitDeposit(ctx: ShopperCtx, txHash: string): Promise<void> {
  const q = await requireQuote(ctx);
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
  await ctx.db.session.updateMany({
    where: { id: s.id, customerEmail: null },
    data: { customerEmail: email.toLowerCase() },
  });
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
