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
import type { ScopeContext, ScopedDb } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { transitionSession } from '../events/transitions.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { toJsonDecimal } from '../lib/serialize.js';
import { resolvePayers } from './pricing.js';
import { tokenInfo } from './tokens.js';

/** The tenant (merchant + mode) plus its scoped client: the request's principal and `req.db`. */
export type CheckoutCtx = ScopeContext & { db: ScopedDb };

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
 * Creates a checkout session. Throws UNSUPPORTED_CURRENCY (400) for a currency other than USD or
 * the settlement asset, ACCOUNT_NOT_READY (409) without an active merchant account or a settlement
 * config in this mode, CONFLICT (409) when `external_ref` belongs to an open or paid session.
 */
export async function createSession(
  ctx: CheckoutCtx,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const { db } = ctx;
  const [account, settlement, merchant] = await Promise.all([
    db.merchantAccount.findFirst({ where: { status: 'active' } }),
    db.settlementConfig.findFirst({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] }),
    db.merchant.findFirstOrThrow({
      select: { defaultFeePayer: true, defaultGasPayer: true },
    }),
  ]);
  if (!account) throw accountNotReady('The store has no active account in this mode yet');
  if (!settlement) throw accountNotReady('The store has no settlement settings in this mode yet');

  // Currency and amount precision.
  const currency = input.amount_currency;
  if (currency === 'USD') {
    assertAmount(input.amount, USD_DECIMALS, 'USD');
  } else if (currency === settlement.destAssetId) {
    const token = await tokenInfo(ctx.livemode, currency);
    assertAmount(input.amount, Math.min(token.decimals, AMOUNT_MAX_SCALE), currency);
  } else {
    throw new AppError(
      'UNSUPPORTED_CURRENCY',
      `amount_currency must be USD or the settlement asset (${settlement.destAssetId})`,
      400,
      { allowed: ['USD', settlement.destAssetId] },
    );
  }

  // The payout destination: the mode's merchant account, or the saved address in wallet mode.
  const recipient =
    settlement.payoutMode === 'intents' ? account.nearAccountId : settlement.payoutAddress;
  if (!recipient) throw accountNotReady('The store has no payout address in this mode yet');

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
      // the ref; expire it (timeout) first so the store's retry is not refused.
      const stale = await tx.session.findMany({
        where: {
          merchantId: t.merchantId,
          livemode: t.livemode,
          externalRef: input.external_ref,
          status: 'PENDING_DEPOSIT',
          expiresAt: { lte: now },
        },
        select: { id: true },
      });
      for (const s of stale) {
        await expireInTx(tx, t, s.id, input.external_ref, 'timeout');
      }
      await tx.session.create({
        data: {
          id,
          merchantId: t.merchantId,
          livemode: t.livemode,
          paymentLinkId: link?.id ?? null,
          externalRef: input.external_ref,
          amountMode: 'EXACT_OUT',
          amount: input.amount,
          amountCurrency: currency,
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

/** The full store-side view of a session: its settings, payments with their refunds, and totals. */
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
  if (!s) throw notFound('Session not found');

  let settledOut = 0n;
  let refundCount = 0;
  for (const p of s.payments) {
    if (p.status === 'SETTLED' && p.amountOut) settledOut += BigInt(p.amountOut.toFixed());
    refundCount += p.refunds.length;
  }

  return {
    id: s.id,
    livemode: s.livemode,
    status: s.status,
    expired_reason: s.expiredReason,
    amount: s.amount.toFixed(),
    amount_currency: s.amountCurrency,
    settlement_asset: s.destAsset,
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
        amount: toJsonDecimal(r.amount),
        destination: r.destination,
        destination_chain: r.destinationChain,
        needs_address: r.needsAddress,
        refund_tx_hash: r.refundTxHash,
        created_at: r.createdAt.toISOString(),
      })),
    })),
    totals: {
      /** Settlement-asset base units delivered by SETTLED payments. */
      settled_amount_out: settledOut.toString(),
      payment_count: s.payments.length,
      refund_count: refundCount,
    },
  };
}
export type SessionView = Awaited<ReturnType<typeof sessionView>>;

/**
 * The store cancels a session: `PENDING_DEPOSIT → EXPIRED` with `expired_reason = canceled`, and
 * `checkout.session.expired`. Any other status is INVALID_STATE_TRANSITION (409).
 */
export async function expireSession(ctx: CheckoutCtx, id: string): Promise<SessionView> {
  await tenantTransaction(ctx, async (tx, t) => {
    const tenant = { merchantId: t.merchantId, livemode: t.livemode };
    const s = await tx.session.findFirst({
      where: { id, ...tenant },
      select: { externalRef: true },
    });
    if (!s) throw notFound('Session not found');
    await expireInTx(tx, t, id, s.externalRef, 'canceled');
  });
  return sessionView(ctx, id);
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
