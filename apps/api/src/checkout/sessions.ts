// Checkout sessions, store side: create (secret key), read, and cancel.
//
// A session pins everything the checkout needs at creation: the settlement asset/chain and the
// recipient come from the merchant's settlement config and merchant account (callers cannot set
// them), and who pays fees and gas is resolved once (session override → payment link → merchant
// default) and stored. The client secret (`ses_<ULID>_secret_<32 hex>`, the format the gateway's
// `session_client` principal parses) is returned once and stored only as its sha256.
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  FeePayerSchema,
  GasPayerSchema,
  SESSION_TTL_MS,
  feePayerFromDb,
  feePayerToDb,
  gasPayerFromDb,
  gasPayerToDb,
  type GasPayer,
} from '@tendr/contracts';
import { z } from 'zod';
import { scopedDb, type ScopeContext, type ScopedDb } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { transitionSession } from '../events/transitions.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toJsonDecimal } from '../lib/serialize.js';
import {
  convertToUsd,
  getUsdRate,
  minorUnits,
  unsupportedCurrency,
  type UsdConversion,
} from './fx.js';
import { depositInFlight } from './in-flight.js';
import { resolvePayers } from './pricing.js';
import { publicReviewReason } from './refunds.js';
import { assetLabel, tokenInfo, type AssetLabel } from './tokens.js';
import { connectionMayAct } from './webhooks.js';

/**
 * The tenant (merchant + mode) plus its scoped client: the request's principal and `req.db`.
 * `connectionId` is the Connect connection of the authenticating key, when it is one.
 */
export type CheckoutCtx = ScopeContext & { db: ScopedDb; connectionId?: string | null };

/** Tendr's fee when the merchant has no fee plan in effect (basis points). */
export const DEFAULT_FEE_BPS = 50;
/** `sessions.amount` is `Decimal(38, 18)`: at most 20 integer digits and 18 fraction digits. */
const AMOUNT_MAX_INT_DIGITS = 20;
const AMOUNT_MAX_SCALE = 18;
const USD_DECIMALS = 2;

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;

const httpUrl = z
  .string()
  .max(2048)
  .url()
  // A regex, not `new URL()`: refinements also run on strings `.url()` rejected, and a throw here
  // would be a 500.
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL');

export const CreateSessionSchema = z
  .object({
    /** A positive decimal string; precision is checked against the currency below. */
    amount: z.string().regex(AMOUNT_RE, 'must be a decimal string like "25.10"'),
    /**
     * `USD`, any ISO 4217 code in the FX table (converted to USD once, at creation), or exactly the
     * settlement asset id.
     */
    amount_currency: z.string().min(1).max(200),
    external_ref: z.string().min(1).max(255),
    success_url: httpUrl,
    cancel_url: httpUrl,
    customer_email: z.string().max(254).email().optional(),
    metadata: z
      .record(z.string().min(1).max(40), z.string().max(500))
      .refine((m) => Object.keys(m).length <= 50, 'at most 50 keys')
      .optional(),
    fee_payer: FeePayerSchema.optional(),
    gas_payer: GasPayerSchema.optional(),
    payment_link_id: z.string().min(1).max(64).optional(),
    /** Seconds until the session expires (60–1800); default 30 minutes. */
    expires_in: z
      .number()
      .int()
      .min(60)
      .max(SESSION_TTL_MS / 1000)
      .optional(),
  })
  .strict();
export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;

export interface CreatedSession {
  id: string;
  client_secret: string;
  url: string;
  expires_at: string;
  status: 'PENDING_DEPOSIT';
}

const amountInvalid = (message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field: 'amount' });

/** Positive, ≤ `maxDecimals` fraction digits, and representable in `Decimal(38, 18)`. */
function assertAmount(amount: string, maxDecimals: number, currency: string): void {
  const m = AMOUNT_RE.exec(amount);
  if (!m) throw amountInvalid('amount must be a decimal string like "25.10"');
  const [, int, frac = ''] = m;
  if (frac.length > maxDecimals) {
    throw amountInvalid(`amount in ${currency} allows at most ${maxDecimals} decimal places`);
  }
  if (int!.replace(/^0+/, '').length > AMOUNT_MAX_INT_DIGITS) {
    throw amountInvalid('amount is too large');
  }
  if (/^0*$/.test(int! + frac)) throw amountInvalid('amount must be greater than 0');
}

function accountNotReady(message: string): AppError {
  return new AppError('ACCOUNT_NOT_READY', message, 409);
}

/** Why a store cannot take payments in a mode yet (the cause of ACCOUNT_NOT_READY). */
export type ReadinessGap = 'account_missing' | 'account_pending' | 'payout_missing';

type Account = NonNullable<Awaited<ReturnType<ScopedDb['merchantAccount']['findFirst']>>>;
type Settlement = NonNullable<Awaited<ReturnType<ScopedDb['settlementConfig']['findFirst']>>>;

/** A store's readiness to take payments in one mode: what a new session needs, or what is missing. */
export type Readiness =
  | { ready: true; account: Account; settlement: Settlement; recipient: string }
  | { ready: false; gap: ReadinessGap; message: string };

const notReady = (gap: ReadinessGap, message: string): Readiness => ({
  ready: false,
  gap,
  message,
});

/**
 * Whether the store can take payments in `livemode` (default: the context's mode): an active
 * merchant account, a settlement config, and a payout destination (the account itself in intents
 * mode, the saved address in wallet mode). The one place these checks live: `createSession`
 * refuses with ACCOUNT_NOT_READY on a gap, and `GET /v1/connect/status` reports it.
 */
export async function readinessFor(
  ctx: CheckoutCtx,
  livemode: boolean = ctx.livemode,
): Promise<Readiness> {
  const db =
    livemode === ctx.livemode ? ctx.db : scopedDb({ merchantId: ctx.merchantId, livemode });
  const [account, settlement] = await Promise.all([
    db.merchantAccount.findFirst({ orderBy: { createdAt: 'desc' } }),
    db.settlementConfig.findFirst({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const noAccount = 'The store has no active account in this mode yet';
  if (!account) return notReady('account_missing', noAccount);
  if (account.status !== 'active') return notReady('account_pending', noAccount);
  if (!settlement) {
    return notReady('payout_missing', 'The store has no settlement settings in this mode yet');
  }
  // The payout destination: the mode's merchant account, or the saved address in wallet mode.
  const recipient =
    settlement.payoutMode === 'intents' ? account.nearAccountId : settlement.payoutAddress;
  if (!recipient) {
    return notReady('payout_missing', 'The store has no payout address in this mode yet');
  }
  return { ready: true, account, settlement, recipient };
}

/** The hosted checkout page of a session (no secret). */
export function hostedUrl(id: string): string {
  return `${env().CHECKOUT_BASE_URL.replace(/\/+$/, '')}/pay/${id}`;
}

/** Statuses that hold an `external_ref` (the partial unique index's predicate). */
const REF_HOLDING_STATUSES = [
  'PENDING_DEPOSIT',
  'PROCESSING',
  'SCREENING_PENDING',
  'SETTLED',
] as const;

/**
 * How Prisma may name the partial unique index `sessions_active_external_ref_key` (migration
 * checkout_external_ref) in a P2002's meta: the index name, the column, or the field.
 */
const EXTERNAL_REF_META = /sessions_active_external_ref_key|external_ref|externalRef/;

const isP2002 = (err: unknown): err is Prisma.PrismaClientKnownRequestError =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Whether a P2002 is the `external_ref` index. The index is raw SQL, so what Prisma reports in
 * `meta` varies by version (or is absent); when the meta names nothing we recognise, ask the
 * database whether a ref-holding session with this ref now exists.
 */
async function isExternalRefConflict(
  ctx: CheckoutCtx,
  err: Prisma.PrismaClientKnownRequestError,
  externalRef: string,
): Promise<boolean> {
  if (EXTERNAL_REF_META.test(JSON.stringify(err.meta ?? {}))) return true;
  const holder = await ctx.db.session.findFirst({
    where: { externalRef, status: { in: [...REF_HOLDING_STATUSES] } },
    select: { id: true },
  });
  return holder !== null;
}

/**
 * Creates a checkout session. A non-USD ISO 4217 total is converted to USD here, once, at the
 * mode's FX rate (fx.ts; test mode always uses the fixed provider): the session stores the USD
 * amount plus the original amount, currency, rate, source and the rate's timestamp, and an
 * `Idempotency-Key` replay returns the stored session without fetching a new rate.
 *
 * Throws UNSUPPORTED_CURRENCY (400) for a currency that is neither an ISO 4217 code in the table
 * nor the settlement asset, FX_RATE_UNAVAILABLE (503) when no current rate is available,
 * ACCOUNT_NOT_READY (409) without an active merchant account or a settlement config in this mode,
 * CONFLICT (409) when `external_ref` belongs to an open or paid session.
 */
export async function createSession(
  ctx: CheckoutCtx,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const { db } = ctx;
  const [readiness, merchant] = await Promise.all([
    readinessFor(ctx),
    db.merchant.findFirstOrThrow({
      select: { defaultFeePayer: true, defaultGasPayer: true },
    }),
  ]);
  if (!readiness.ready) throw accountNotReady(readiness.message);
  const { account, settlement, recipient } = readiness;

  // Currency and amount precision. A non-USD ISO total is converted to USD now, once; the session
  // is then priced in USD like any other.
  let currency = input.amount_currency;
  let amount = input.amount;
  let fx: UsdConversion | null = null;
  if (currency === 'USD') {
    assertAmount(amount, USD_DECIMALS, 'USD');
  } else if (currency === settlement.destAssetId) {
    const token = await tokenInfo(ctx.livemode, currency);
    assertAmount(amount, Math.min(token.decimals, AMOUNT_MAX_SCALE), currency);
  } else {
    const minor = minorUnits(currency);
    if (minor === undefined) throw unsupportedCurrency(currency, settlement.destAssetId);
    // Precision first, so a malformed amount never costs a provider call.
    assertAmount(amount, minor, currency);
    const rate = await getUsdRate(currency, new Date(), { livemode: ctx.livemode });
    fx = convertToUsd(amount, currency, rate);
    // The USD amount must pass the same checks as an amount given in USD.
    assertAmount(fx.usd, USD_DECIMALS, 'USD');
    amount = fx.usd;
    currency = 'USD';
  }

  const link = input.payment_link_id
    ? await db.paymentLink.findFirst({
        where: { id: input.payment_link_id },
        select: { id: true, gasSponsor: true, gasMaxUsd: true },
      })
    : null;
  if (input.payment_link_id && !link) throw notFound('Payment link not found');

  const now = new Date();
  const plan = await db.feePlan.findFirst({
    where: { effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
    select: { feeBps: true },
  });

  const linkGas: GasPayer | null =
    link && link.gasSponsor !== 'default' ? gasPayerFromDb(link.gasSponsor) : null;
  const payers = resolvePayers({
    sessionOverride: { feePayer: input.fee_payer, gasPayer: input.gas_payer },
    // Payment links carry no fee-payer setting yet (project 5).
    link: link ? { gasPayer: linkGas } : null,
    merchant: {
      defaultFeePayer: feePayerFromDb(merchant.defaultFeePayer),
      defaultGasPayer: gasPayerFromDb(merchant.defaultGasPayer),
    },
  });

  const id = newId('ses');
  const clientSecret = `${id}_secret_${randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(
    now.getTime() + (input.expires_in !== undefined ? input.expires_in * 1000 : SESSION_TTL_MS),
  );

  try {
    await tenantTransaction(ctx, async (tx, t) => {
      // A PENDING_DEPOSIT session past its expiry that the sweeper has not reached yet still holds
      // the ref; expire it (timeout) first so the store's retry is not refused — unless a deposit
      // is in flight (the sweeper's own test, in-flight.ts): then the ref stays held, 409.
      const stale = await tx.session.findMany({
        where: {
          merchantId: t.merchantId,
          livemode: t.livemode,
          externalRef: input.external_ref,
          status: 'PENDING_DEPOSIT',
          expiresAt: { lte: now },
        },
        select: { id: true, merchantId: true, livemode: true, expiresAt: true },
      });
      for (const s of stale) {
        await lockSession(tx, s.id);
        if (await depositInFlight(tx, s, now)) throw depositInProgress(s.id, 'CONFLICT');
        await expireInTx(tx, t, s.id, input.external_ref, 'timeout');
      }
      await tx.session.create({
        data: {
          id,
          merchantId: t.merchantId,
          livemode: t.livemode,
          paymentLinkId: link?.id ?? null,
          connectionId: ctx.connectionId ?? null,
          externalRef: input.external_ref,
          amountMode: 'EXACT_OUT',
          amount,
          amountCurrency: currency,
          originalAmount: fx?.amount ?? null,
          originalCurrency: fx?.currency ?? null,
          fxRate: fx?.rate ?? null,
          fxSource: fx?.source ?? null,
          fxAsOf: fx?.asOf ?? null,
          destAsset: settlement.destAssetId,
          destChain: settlement.destChain,
          recipient,
          recipientType: settlement.payoutMode === 'intents' ? 'INTENTS' : 'DESTINATION_CHAIN',
          intentsAccount: account.nearAccountId,
          delivery: 'WEBHOOK',
          metadata: input.metadata ?? {},
          feeBps: plan?.feeBps ?? DEFAULT_FEE_BPS,
          feePayer: feePayerToDb(payers.feePayer),
          gasSponsor: gasPayerToDb(payers.gasPayer),
          gasMaxUsd: link?.gasMaxUsd ?? null,
          expiresAt,
          clientSecretHash: sha256(clientSecret),
          successUrl: input.success_url,
          cancelUrl: input.cancel_url,
          customerEmail: input.customer_email?.toLowerCase() ?? null,
        },
      });
      await recordEvent(tx, t, {
        aggregateType: 'session',
        aggregateId: id,
        type: 'session.created',
        payload: { session_id: id, external_ref: input.external_ref },
      });
    });
  } catch (err) {
    if (isP2002(err) && (await isExternalRefConflict(ctx, err, input.external_ref))) {
      throw conflict('A session with this external_ref is already open or paid', {
        external_ref: input.external_ref,
      });
    }
    throw err;
  }

  return {
    id,
    client_secret: clientSecret,
    url: `${hostedUrl(id)}#cs=${clientSecret}`,
    expires_at: expiresAt.toISOString(),
    status: 'PENDING_DEPOSIT',
  };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The full store-side view of a session: its settings, payments with their refunds, and totals.
 * A connection key sees only its own connection's (or a replaced predecessor's) sessions (B1);
 * any other session is NOT_FOUND.
 */
export async function sessionView(ctx: CheckoutCtx, id: string) {
  const s = await ctx.db.session.findFirst({
    where: { id },
    include: {
      payments: {
        orderBy: { createdAt: 'asc' },
        include: { refunds: { orderBy: { createdAt: 'asc' } } },
      },
    },
  });
  if (!s || !(await connectionMayAct(ctx.connectionId, ctx.merchantId, s.connectionId))) {
    throw notFound('Session not found');
  }

  // C6: the settlement asset and each refund's asset, as symbol + decimals (best effort, cached).
  const labels = new Map<string, AssetLabel | null>();
  for (const assetId of [
    s.destAsset,
    ...s.payments.flatMap((p) => p.refunds.map((r) => r.assetId)),
  ]) {
    if (!labels.has(assetId)) labels.set(assetId, await assetLabel(s.livemode, assetId));
  }
  const label = (assetId: string) => labels.get(assetId) ?? null;

  let settledOut = 0n;
  let refundCount = 0;
  for (const p of s.payments) {
    // Settled payments, including ones the store has since refunded (part or all of).
    const settledOnce =
      p.status === 'SETTLED' ||
      p.status === 'PARTIALLY_REFUNDED' ||
      (p.status === 'REFUNDED' && p.settledAt !== null);
    if (settledOnce && p.amountOut) settledOut += BigInt(p.amountOut.toFixed());
    refundCount += p.refunds.length;
  }

  return {
    id: s.id,
    livemode: s.livemode,
    status: s.status,
    expired_reason: s.expiredReason,
    amount: s.amount.toFixed(),
    amount_currency: s.amountCurrency,
    /** The order total as the store priced it, when it was converted from another currency. */
    original_amount:
      s.originalAmount && s.originalCurrency
        ? s.originalAmount.toFixed(minorUnits(s.originalCurrency) ?? 2)
        : null,
    original_currency: s.originalCurrency,
    /** The conversion at creation: "1 USD = rate <original_currency>"; null when not converted. */
    fx:
      s.fxRate && s.fxSource && s.fxAsOf
        ? { rate: s.fxRate.toFixed(), source: s.fxSource, as_of: s.fxAsOf.toISOString() }
        : null,
    settlement_asset: s.destAsset,
    settlement_asset_symbol: label(s.destAsset)?.symbol ?? null,
    settlement_asset_decimals: label(s.destAsset)?.decimals ?? null,
    settlement_chain: s.destChain,
    external_ref: s.externalRef,
    customer_email: s.customerEmail,
    metadata: s.metadata,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    fee_payer: feePayerFromDb(s.feePayer),
    gas_payer: gasPayerFromDb(s.gasSponsor),
    fee_bps: s.feeBps,
    gas_max_usd: toJsonDecimal(s.gasMaxUsd),
    payment_link_id: s.paymentLinkId,
    url: hostedUrl(s.id),
    expires_at: s.expiresAt.toISOString(),
    created_at: s.createdAt.toISOString(),
    payments: s.payments.map((p) => ({
      id: p.id,
      status: p.status,
      is_late: p.isLate,
      held_reason: p.heldReason,
      amount_received: toJsonDecimal(p.amountReceived),
      amount_out: toJsonDecimal(p.amountOut),
      amount_in_usd: toJsonDecimal(p.amountInUsd),
      overpaid_amount: toJsonDecimal(p.overpaidAmount),
      refunded_amount: toJsonDecimal(p.refundedAmount),
      kept_small_overpayment: p.keptSmallOverpayment,
      origin_tx_hash: p.originTxHash,
      sender_chain: p.senderChain,
      settled_at: iso(p.settledAt),
      created_at: p.createdAt.toISOString(),
      refunds: p.refunds.map((r) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        asset_id: r.assetId,
        asset_symbol: label(r.assetId)?.symbol ?? null,
        asset_decimals: label(r.assetId)?.decimals ?? null,
        amount: toJsonDecimal(r.amount),
        destination: r.destination,
        destination_chain: r.destinationChain,
        needs_address: r.needsAddress,
        review_reason: publicReviewReason(r.reviewReason),
        refund_tx_hash: r.refundTxHash,
        created_at: r.createdAt.toISOString(),
      })),
    })),
    totals: {
      /** Settlement-asset base units delivered by payments that settled (since refunded too). */
      settled_amount_out: settledOut.toString(),
      payment_count: s.payments.length,
      refund_count: refundCount,
    },
  };
}
export type SessionView = Awaited<ReturnType<typeof sessionView>>;

/**
 * 409 while a session's deposit is in flight (I-1): CONFLICT when a new session for the ref is
 * refused (the ref is still held), DEPOSIT_IN_PROGRESS when the store's cancel is refused.
 */
function depositInProgress(sessionId: string, code: 'CONFLICT' | 'DEPOSIT_IN_PROGRESS'): AppError {
  return new AppError(
    code,
    'A deposit for this session is still in progress; retry once it is processed',
    409,
    { reason: 'deposit_in_progress', session_id: sessionId },
  );
}

/** Row-locks a session (`FOR UPDATE`) so the in-flight check and the expiry see one state. */
async function lockSession(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${id} FOR UPDATE`;
}

/**
 * The store cancels a session: `PENDING_DEPOSIT → EXPIRED` with `expired_reason = canceled`, and
 * `checkout.session.expired`. Any other status is INVALID_STATE_TRANSITION (409); a deposit in
 * flight is CONFLICT (409, `details.reason: deposit_in_progress`).
 */
export async function expireSession(ctx: CheckoutCtx, id: string): Promise<SessionView> {
  await tenantTransaction(ctx, async (tx, t) => {
    const tenant = { merchantId: t.merchantId, livemode: t.livemode };
    const s = await tx.session.findFirst({
      where: { id, ...tenant },
      select: {
        id: true,
        merchantId: true,
        livemode: true,
        expiresAt: true,
        externalRef: true,
        connectionId: true,
      },
    });
    // B1: a connection key cancels only its own connection's (or a predecessor's) sessions.
    if (!s || !(await connectionMayAct(ctx.connectionId, t.merchantId, s.connectionId))) {
      throw notFound('Session not found');
    }
    await lockSession(tx, id);
    const cur = await tx.session.findFirstOrThrow({
      where: { id, ...tenant },
      select: { status: true },
    });
    // A deposit in flight (in-flight.ts, the sweeper's own test) is never canceled under the
    // shopper: it would turn an on-time payment late. Other statuses fail the transition below.
    if (cur.status === 'PENDING_DEPOSIT' && (await depositInFlight(tx, s, new Date()))) {
      throw depositInProgress(id, 'DEPOSIT_IN_PROGRESS');
    }
    await expireInTx(tx, t, id, s.externalRef, 'canceled');
  });
  return sessionView(ctx, id);
}

/**
 * A4: when a connection goes away with no successor (a site Disconnect, a dashboard removal, the
 * sweeper), its open sessions — and those of the connections it replaced — would stay payable
 * while their outcome can no longer reach the site. Each `PENDING_DEPOSIT` one with no deposit in
 * flight is cancelled (`canceled`, `checkout.session.expired`) in the caller's transaction; one
 * with a deposit in flight is left to finish (it is counted, for the caller to report).
 */
export async function expireConnectionSessions(
  tx: Prisma.TransactionClient,
  merchantId: string,
  connectionIds: string[],
  now = new Date(),
): Promise<{ expired: number; inFlight: number }> {
  const out = { expired: 0, inFlight: 0 };
  if (connectionIds.length === 0) return out;
  const open = await tx.session.findMany({
    where: { merchantId, connectionId: { in: connectionIds }, status: 'PENDING_DEPOSIT' },
    select: { id: true, merchantId: true, livemode: true, expiresAt: true, externalRef: true },
    orderBy: { id: 'asc' },
  });
  for (const s of open) {
    await lockSession(tx, s.id);
    const cur = await tx.session.findFirst({
      where: { id: s.id, merchantId, livemode: s.livemode },
      select: { status: true },
    });
    if (cur?.status !== 'PENDING_DEPOSIT') continue;
    if (await depositInFlight(tx, s, now)) {
      out.inFlight += 1;
      continue;
    }
    await expireInTx(tx, { merchantId, livemode: s.livemode }, s.id, s.externalRef, 'canceled');
    out.expired += 1;
  }
  return out;
}

/**
 * `PENDING_DEPOSIT → EXPIRED` with `expired_reason`, plus `checkout.session.expired`, inside the
 * caller's `tenantTransaction` (same `ctx`). Any other status is INVALID_STATE_TRANSITION (409);
 * a concurrent change is CONFLICT (409).
 */
export async function expireInTx(
  tx: Prisma.TransactionClient,
  ctx: ScopeContext,
  id: string,
  externalRef: string | null,
  reason: 'timeout' | 'canceled',
): Promise<void> {
  await transitionSession(tx, ctx, id, 'EXPIRED', { reason });
  await tx.session.updateMany({
    where: { id, merchantId: ctx.merchantId, livemode: ctx.livemode },
    data: { expiredReason: reason },
  });
  await recordEvent(tx, ctx, {
    aggregateType: 'session',
    aggregateId: id,
    type: 'checkout.session.expired',
    payload: { session_id: id, external_ref: externalRef, reason },
  });
}
