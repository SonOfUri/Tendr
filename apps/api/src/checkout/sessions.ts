// Checkout sessions, store side: create (secret key), read, and cancel.
//
// A session pins everything the checkout needs at creation: the settlement asset/chain and the
// recipient come from the merchant's settlement config and merchant account. A payment link may
// override the asset credited to that same account; it cannot supply a payout address. Who pays
// fees and gas is resolved once (session override → payment link → merchant
// default) and stored. The client secret (`ses_<ULID>_secret_<32 hex>`, the format the gateway's
// `session_client` principal parses) is returned once and stored only as its sha256.
import { randomBytes } from 'node:crypto';
import { Prisma, type PaymentLink } from '@prisma/client';
import {
  FeePayerSchema,
  GasPayerSchema,
  HookDataSchema,
  LINE_ITEMS_MAX,
  LineItemSchema,
  SESSION_TTL_MS,
  feePayerFromDb,
  feePayerToDb,
  gasPayerFromDb,
  gasPayerToDb,
  type GasPayer,
  type PaymentLinkAvailability,
} from '@tendr/contracts';
import { z } from 'zod';
import { scopedDb, type ScopeContext, type ScopedDb } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { checkoutUrl } from './urls.js';
import { recordEvent } from '../events/record.js';
import { transitionSession } from '../events/transitions.js';
import { networkFeeView } from '../gas/quote-fee.js';
import { hookDeliveryFor } from '../hooks/destination.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { linkAvailability } from '../payment-links/links.js';
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
import { merchantRefundStatus, publicReviewReason } from './refunds.js';
import { assetLabel, tokenInfo, type AssetLabel } from './tokens.js';
import { sessionRefs, type SessionRefsInput } from './session-refs.js';
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
export const USD_DECIMALS = 2;

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
    /**
     * Integrator stores settling into their own contract (NEAR or a supported EVM chain): the
     * store's reference (e.g. a player or order id), any JSON up to 1 KB serialized. It is passed
     * to the contract's `onTendrDeposit` / `on_tendr_deposit` once the payment settles; giving it
     * sets `delivery = HOOK`.
     */
    hook_data: HookDataSchema.optional(),
    payment_link_id: z.string().min(1).max(64).optional(),
    /** One of the merchant's themes; a live session renders it only once published. */
    theme_id: z.string().min(1).max(64).optional(),
    /** Cart lines for the order summary; `unit_amount` follows the session currency's precision. */
    line_items: z.array(LineItemSchema).max(LINE_ITEMS_MAX).optional(),
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

/**
 * What `createSession` takes: the store route's input, or a payment link's (the public "Pay"
 * route), which has no `external_ref` — there is no order; payments are told apart by session id.
 */
export type InternalSessionInput = Omit<
  CreateSessionInput,
  'external_ref' | 'success_url' | 'cancel_url'
> & { external_ref?: string; success_url: string; cancel_url: string };

/** A session from a payment link's public page: where the payer returns, and their note. */
export interface FromLink {
  linkId: string;
  payerNote: string | null;
  returnUrl: string;
}

/**
 * A session from a link's public page expires this soon unless it is quoted; the first quote
 * extends it to `createdAt + SESSION_TTL_MS` (quotes.ts), so unquoted sessions stop holding a use
 * of the link within minutes.
 */
export const LINK_UNQUOTED_TTL_MS = 5 * 60_000;

/** A link refuses new public sessions (LINK_BUSY) at this many open sessions with a quote. */
export const LINK_MAX_QUOTED_SESSIONS = 200;

/**
 * The open sessions of a link: each one holds a use of it. A session waiting for its deposit
 * (PENDING_DEPOSIT) holds it until `expiresAt`; one whose deposit arrived (PROCESSING,
 * SCREENING_PENDING) holds it with no expiry condition, because that payment can still settle
 * after the session's expiry passes.
 */
export function linkOpenSessions(t: ScopeContext, linkId: string, now: Date) {
  return {
    merchantId: t.merchantId,
    livemode: t.livemode,
    paymentLinkId: linkId,
    OR: [
      { status: 'PENDING_DEPOSIT' as const, expiresAt: { gt: now } },
      { status: { in: ['PROCESSING' as const, 'SCREENING_PENDING' as const] } },
    ],
  };
}

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
export function assertAmount(amount: string, maxDecimals: number, currency: string): void {
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

/** Each line's `unit_amount` has at most `maxDecimals` fraction digits and fits the column. */
function assertLineItemAmounts(
  items: readonly { unit_amount: string }[],
  maxDecimals: number,
  currency: string,
): void {
  items.forEach((item, i) => {
    const [int = '', frac = ''] = item.unit_amount.split('.');
    const problem =
      frac.length > maxDecimals
        ? `unit_amount in ${currency} allows at most ${maxDecimals} decimal places`
        : int.replace(/^0+/, '').length > AMOUNT_MAX_INT_DIGITS
          ? 'unit_amount is too large'
          : null;
    if (problem) {
      throw new AppError('VALIDATION_ERROR', `line_items[${i}]: ${problem}`, 400, {
        field: `line_items.${i}.unit_amount`,
      });
    }
  });
}

function accountNotReady(message: string): AppError {
  return new AppError('ACCOUNT_NOT_READY', message, 409);
}

/**
 * LINK_UNAVAILABLE (409). The public page never tells an archived link from a switched-off one
 * (spec §2.3), so `publicView` reports `archived` as `inactive`.
 */
export function linkUnavailable(
  availability: PaymentLinkAvailability,
  publicView = false,
): AppError {
  const reported = publicView && availability === 'archived' ? 'inactive' : availability;
  return new AppError('LINK_UNAVAILABLE', 'This link is not taking payments right now', 409, {
    availability: reported,
  });
}

const linkReserved = () =>
  new AppError('LINK_RESERVED', 'Someone is paying this link right now, try again shortly.', 409);

const linkBusy = () =>
  new AppError('LINK_BUSY', 'This link is busy right now, try again in a few minutes.', 429);

type LockedLink = Pick<
  PaymentLink,
  'id' | 'feePayer' | 'gasSponsor' | 'gasMaxUsd' | 'settlementAssetId'
>;

/**
 * Inside the session-insert transaction: row-locks the link (`FOR UPDATE`, so concurrent
 * sessions for one link serialise here), then refuses unless it can take a payment right now.
 * With `max_uses`, settled uses plus open sessions (each reserves a use until it expires) must
 * stay below it: LINK_RESERVED while some are only reserved, LINK_UNAVAILABLE `used_up` when all
 * are settled. A public session is also refused (LINK_BUSY) at `LINK_MAX_QUOTED_SESSIONS` open
 * sessions that have a quote (unquoted ones expire within minutes and do not count).
 */
async function lockLinkForSession(
  tx: Prisma.TransactionClient,
  t: ScopeContext,
  linkId: string,
  now: Date,
  publicPath: boolean,
): Promise<LockedLink> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payment_links
    WHERE id = ${linkId} AND merchant_id = ${t.merchantId} AND livemode = ${t.livemode}
    FOR UPDATE`;
  if (locked.length === 0) throw notFound('Payment link not found');
  const link = await tx.paymentLink.findFirstOrThrow({
    where: { id: linkId, merchantId: t.merchantId, livemode: t.livemode },
  });
  // The caller already refused a store that is not ready (ACCOUNT_NOT_READY).
  const availability = linkAvailability(link, { now, merchantReady: true });
  if (availability !== 'available') throw linkUnavailable(availability, publicPath);

  const open = linkOpenSessions(t, linkId, now);
  if (link.maxUses !== null) {
    const holding = await tx.session.count({ where: open });
    if (link.useCount + holding >= link.maxUses) {
      throw holding > 0 ? linkReserved() : linkUnavailable('used_up', publicPath);
    }
  }
  if (publicPath) {
    const quoted = await tx.session.count({ where: { ...open, quotes: { some: {} } } });
    if (quoted >= LINK_MAX_QUOTED_SESSIONS) throw linkBusy();
  }
  return link;
}

/** Why a store cannot take payments in a mode yet (the cause of ACCOUNT_NOT_READY). */
export type ReadinessGap = 'account_missing' | 'account_pending' | 'payout_missing';

type Account = NonNullable<Awaited<ReturnType<ScopedDb['merchantAccount']['findFirst']>>>;
type Settlement = Pick<
  NonNullable<Awaited<ReturnType<ScopedDb['settlementConfig']['findFirst']>>>,
  'destAssetId' | 'destChain' | 'payoutMode' | 'payoutAddress' | 'nearAccount'
>;

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
 * merchant account, a settlement config (or a link's asset override), and a payout destination (the account itself in intents
 * mode, the saved address in wallet mode). The one place these checks live: `createSession`
 * refuses with ACCOUNT_NOT_READY on a gap, and `GET /v1/connect/status` reports it.
 */
export async function readinessFor(
  ctx: CheckoutCtx,
  livemode: boolean = ctx.livemode,
  settlementAsset?: string | null,
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
  // A per-link asset override supplies its own payout choice. It can only credit this store's
  // Tendr account; the asset's source chain does not change the on-NEAR Intents recipient.
  if (settlementAsset)
    return {
      ready: true,
      account,
      recipient: account.nearAccountId,
      settlement: {
        destAssetId: settlementAsset,
        destChain: 'near',
        payoutMode: 'intents',
        payoutAddress: null,
        nearAccount: account.nearAccountId,
      },
    };
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
  return checkoutUrl(id);
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
 *
 * A session naming a payment link (`payment_link_id`, or `opts.fromLink` from the link's public
 * page) takes the link's settlement asset, fee and gas settings and must pass `lockLinkForSession` (LINK_UNAVAILABLE,
 * LINK_RESERVED, LINK_BUSY). `fromLink` sessions have no `external_ref`, store the payer's note,
 * return to the link page, and start with `LINK_UNQUOTED_TTL_MS` instead of the caller's expiry.
 */
export async function createSession(
  ctx: CheckoutCtx,
  input: InternalSessionInput,
  opts: { fromLink?: FromLink } = {},
): Promise<CreatedSession> {
  // Every way a session is made (API key, connection, payment link) comes through here, so the
  // live-mode switch is checked here too, not only at the gateway.
  if (ctx.livemode) assertLiveModeOpen();
  const { fromLink } = opts;
  const linkId = fromLink?.linkId ?? input.payment_link_id;
  const { db } = ctx;
  const linkSnapshot = linkId
    ? await db.paymentLink.findFirst({ where: { id: linkId }, select: { settlementAssetId: true } })
    : null;
  if (linkId && !linkSnapshot) throw notFound('Payment link not found');
  const linkAsset = linkSnapshot?.settlementAssetId ?? null;
  // Validate against this mode's current catalog before taking a database lock.
  if (linkAsset) await tokenInfo(ctx.livemode, linkAsset);
  const [readiness, merchant] = await Promise.all([
    readinessFor(ctx, ctx.livemode, linkAsset),
    db.merchant.findFirstOrThrow({
      select: { defaultFeePayer: true, defaultGasPayer: true, kind: true },
    }),
  ]);
  if (!readiness.ready) throw accountNotReady(readiness.message);
  const { account, settlement, recipient } = readiness;
  // Integrator hooks (gasless spec §4.1): before any FX call, so a refused hook costs nothing.
  const hook = await hookDeliveryFor({
    livemode: ctx.livemode,
    merchantKind: merchant.kind,
    payoutMode: settlement.payoutMode,
    chain: settlement.destChain,
    recipient,
    hookData: input.hook_data,
  });

  // Currency and amount precision. A non-USD ISO total is converted to USD now, once; the session
  // is then priced in USD like any other.
  let currency = input.amount_currency;
  let amount = input.amount;
  let fx: UsdConversion | null = null;
  const lineItems = input.line_items;
  if (currency === 'USD') {
    assertAmount(amount, USD_DECIMALS, 'USD');
    if (lineItems) assertLineItemAmounts(lineItems, USD_DECIMALS, 'USD');
  } else if (currency === settlement.destAssetId) {
    const token = await tokenInfo(ctx.livemode, currency);
    const scale = Math.min(token.decimals, AMOUNT_MAX_SCALE);
    assertAmount(amount, scale, currency);
    if (lineItems) assertLineItemAmounts(lineItems, scale, currency);
  } else {
    const minor = minorUnits(currency);
    if (minor === undefined) throw unsupportedCurrency(currency, settlement.destAssetId);
    // Precision first, so a malformed amount never costs a provider call.
    assertAmount(amount, minor, currency);
    if (lineItems) assertLineItemAmounts(lineItems, minor, currency);
    const rate = await getUsdRate(currency, new Date(), { livemode: ctx.livemode });
    fx = convertToUsd(amount, currency, rate);
    // The USD amount must pass the same checks as an amount given in USD.
    assertAmount(fx.usd, USD_DECIMALS, 'USD');
    amount = fx.usd;
    currency = 'USD';
  }

  // A theme of another merchant is not found (the scoped client sees only this merchant's).
  if (
    input.theme_id &&
    !(await db.checkoutTheme.findFirst({ where: { id: input.theme_id }, select: { id: true } }))
  ) {
    throw notFound('No theme with that id');
  }

  const now = new Date();
  const plan = await db.feePlan.findFirst({
    where: { effectiveFrom: { lte: now } },
    orderBy: { effectiveFrom: 'desc' },
    select: { feeBps: true },
  });

  const id = newId('ses');
  const clientSecret = `${id}_secret_${randomBytes(16).toString('hex')}`;
  const ttl = fromLink
    ? LINK_UNQUOTED_TTL_MS
    : input.expires_in !== undefined
      ? input.expires_in * 1000
      : SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const externalRef = input.external_ref ?? null;

  try {
    await tenantTransaction(ctx, async (tx, t) => {
      // Every session naming a link: lock it and check it can take this payment (spec §2.5).
      const link = linkId ? await lockLinkForSession(tx, t, linkId, now, !!fromLink) : null;
      if ((link?.settlementAssetId ?? null) !== linkAsset) {
        throw conflict('The link’s settlement token changed. Please try again.');
      }
      const linkGas: GasPayer | null =
        link && link.gasSponsor !== 'default' ? gasPayerFromDb(link.gasSponsor) : null;
      const payers = resolvePayers({
        sessionOverride: { feePayer: input.fee_payer, gasPayer: input.gas_payer },
        link: link
          ? { feePayer: link.feePayer ? feePayerFromDb(link.feePayer) : null, gasPayer: linkGas }
          : null,
        merchant: {
          defaultFeePayer: feePayerFromDb(merchant.defaultFeePayer),
          defaultGasPayer: gasPayerFromDb(merchant.defaultGasPayer),
        },
      });

      // A PENDING_DEPOSIT session past its expiry that the sweeper has not reached yet still holds
      // the ref; expire it (timeout) first so the store's retry is not refused — unless a deposit
      // is in flight (the sweeper's own test, in-flight.ts): then the ref stays held, 409. Only
      // with a ref (spec §10): without one this filter would match every overdue session.
      if (externalRef !== null) {
        const stale = await tx.session.findMany({
          where: {
            merchantId: t.merchantId,
            livemode: t.livemode,
            externalRef,
            status: 'PENDING_DEPOSIT',
            expiresAt: { lte: now },
          },
          select: {
            id: true,
            merchantId: true,
            livemode: true,
            expiresAt: true,
            externalRef: true,
            paymentLinkId: true,
            payerNote: true,
          },
        });
        for (const s of stale) {
          await lockSession(tx, s.id);
          if (await depositInFlight(tx, s, now)) throw depositInProgress(s.id, 'CONFLICT');
          await expireInTx(tx, t, s.id, s, 'timeout');
        }
      }
      await tx.session.create({
        data: {
          id,
          merchantId: t.merchantId,
          livemode: t.livemode,
          paymentLinkId: link?.id ?? null,
          connectionId: ctx.connectionId ?? null,
          themeId: input.theme_id ?? null,
          lineItems: lineItems ?? Prisma.DbNull,
          externalRef,
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
          delivery: hook.delivery,
          hookData: hook.hookData ?? Prisma.DbNull,
          metadata: input.metadata ?? {},
          payerNote: fromLink?.payerNote ?? null,
          feeBps: plan?.feeBps ?? DEFAULT_FEE_BPS,
          feePayer: feePayerToDb(payers.feePayer),
          gasSponsor: gasPayerToDb(payers.gasPayer),
          gasMaxUsd: link?.gasMaxUsd ?? null,
          expiresAt,
          clientSecretHash: sha256(clientSecret),
          successUrl: fromLink?.returnUrl ?? input.success_url,
          cancelUrl: fromLink?.returnUrl ?? input.cancel_url,
          customerEmail: input.customer_email?.toLowerCase() ?? null,
        },
      });
      await recordEvent(tx, t, {
        aggregateType: 'session',
        aggregateId: id,
        type: 'session.created',
        payload: {
          session_id: id,
          ...sessionRefs({
            externalRef,
            paymentLinkId: link?.id ?? null,
            payerNote: fromLink?.payerNote ?? null,
          }),
        },
      });
    });
  } catch (err) {
    if (
      externalRef !== null &&
      isP2002(err) &&
      (await isExternalRefConflict(ctx, err, externalRef))
    ) {
      throw conflict('A session with this external_ref is already open or paid', {
        external_ref: externalRef,
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
        include: { refunds: { orderBy: { createdAt: 'asc' } }, quote: true },
      },
      quotes: { where: { supersededAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
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
    /** The payer's note from a payment link's page (plain text; escape it wherever shown). */
    payer_note: s.payerNote,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    fee_payer: feePayerFromDb(s.feePayer),
    gas_payer: gasPayerFromDb(s.gasSponsor),
    /** `hook`: the settlement contract is called (`onTendrDeposit`) once a payment settles. */
    delivery: s.delivery === 'HOOK' ? 'hook' : 'webhook',
    hook_data: s.hookData ?? null,
    fee_bps: s.feeBps,
    gas_max_usd: toJsonDecimal(s.gasMaxUsd),
    /** The current quote's network fee (who pays it, how, why); null without a quote. */
    network_fee: s.quotes[0] ? networkFeeView(s.quotes[0]) : null,
    payment_link_id: s.paymentLinkId,
    theme_id: s.themeId,
    /** The cart lines as sent at creation; null when none were given. */
    line_items: s.lineItems ?? null,
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
      /** The paid quote's network fee; null for payments quoted before gasless payments. */
      network_fee: networkFeeView(p.quote),
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
        // A store refund's own reference and its state as the store sees it (C5); null for the
        // automatic returns (overpaid, underpaid, late, …).
        refund_external_ref: r.reason === 'merchant' ? r.externalRef : null,
        merchant_status: r.reason === 'merchant' ? merchantRefundStatus(r) : null,
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
        paymentLinkId: true,
        payerNote: true,
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
    await expireInTx(tx, t, id, s, 'canceled');
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
    select: {
      id: true,
      merchantId: true,
      livemode: true,
      expiresAt: true,
      externalRef: true,
      paymentLinkId: true,
      payerNote: true,
    },
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
    await expireInTx(tx, { merchantId, livemode: s.livemode }, s.id, s, 'canceled');
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
  refs: SessionRefsInput,
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
    payload: { session_id: id, ...sessionRefs(refs), reason },
  });
}
