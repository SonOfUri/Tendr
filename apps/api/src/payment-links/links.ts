// Payment links, merchant side: create, read, list, update and archive, plus the two pure
// helpers the public side shares (availability and URLs) and the $1.00 floor check.
//
// A link is a reusable price (fixed, or open with an optional higher minimum) in USD or an
// ISO 4217 currency. Everything here runs through the scoped client, so a merchant never sees
// another merchant's or another mode's link. `expired` is computed on read, never persisted.
import { Prisma, type PaymentLink } from '@prisma/client';
import {
  LINK_MIN_USD,
  RESERVED_LINK_SLUGS,
  LINK_SLUG_RE,
  feePayerFromDb,
  feePayerToDb,
  gasPayerFromDb,
  gasPayerToDb,
  type PaymentLinkAvailability,
  type PaymentLinkCreate,
  type PaymentLinkUpdate,
} from '@tendr/contracts';
import { getUsdRate, minorUnits, unsupportedCurrency, type FxOptions } from '../checkout/fx.js';
import { assertAmount, readinessFor } from '../checkout/sessions.js';
import type { ScopedDb } from '../db/scoped.js';
import { env } from '../env.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

export type LinkCtx = { merchantId: string; livemode: boolean; db: ScopedDb };

type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

const GAS_MAX_DECIMALS = 6;
const USD_MINOR = 2;
const SLUG_MAX = 60;

export interface PaymentLinkView {
  id: string;
  object: 'payment_link';
  livemode: boolean;
  title: string;
  description: string | null;
  slug: string;
  url: string;
  qr_url: string;
  amount_type: 'fixed' | 'open';
  amount: string | null;
  currency: string;
  min_amount: string | null;
  note: 'off' | 'optional';
  /** Null = the store's default. */
  fee_payer: 'merchant' | 'shopper' | null;
  /** Null = the store's default. */
  gas_payer: 'merchant' | 'shopper' | null;
  gas_max_usd: string | null;
  status: 'active' | 'inactive';
  archived: boolean;
  availability: PaymentLinkAvailability;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  total_paid: string;
  total_refunded: string;
  total_paid_usd: string;
  total_refunded_usd: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Why a link can or cannot be paid right now. Order matters: archived, inactive, expired,
 * used_up, merchant_not_ready, available.
 */
export function linkAvailability(
  link: Pick<PaymentLink, 'archivedAt' | 'status' | 'expiresAt' | 'maxUses' | 'useCount'>,
  opts: { now: Date; merchantReady: boolean },
): PaymentLinkAvailability {
  if (link.archivedAt !== null) return 'archived';
  if (link.status === 'inactive') return 'inactive';
  if (link.status === 'expired' || (link.expiresAt !== null && link.expiresAt <= opts.now)) {
    return 'expired';
  }
  if (link.maxUses !== null && link.useCount >= link.maxUses) return 'used_up';
  if (!opts.merchantReady) return 'merchant_not_ready';
  return 'available';
}

/** The shareable page and its QR image. Test links carry `?mode=test`. */
export function linkUrls(
  merchantSlug: string,
  linkSlug: string,
  livemode: boolean,
): { url: string; qr_url: string } {
  const base = `${env().CHECKOUT_BASE_URL.replace(/\/+$/, '')}/pay/${merchantSlug}/${linkSlug}`;
  const mode = livemode ? '' : '?mode=test';
  return { url: `${base}${mode}`, qr_url: `${base}/qr${mode}` };
}

const tooLow = (min: string) =>
  new AppError('AMOUNT_TOO_LOW', `The amount must be at least USD ${LINK_MIN_USD} (${min})`, 400, {
    field: 'amount',
    min_amount: min,
  });

/**
 * Throws AMOUNT_TOO_LOW when `amount` of `currency` is worth less than the USD 1.00 floor.
 * `details.min_amount` is the floor in `currency`, rounded UP to its minor units. A USD amount
 * needs no FX call; any other currency needs a current rate (FX_RATE_UNAVAILABLE otherwise).
 * `fx` picks the mode's rate provider (`{ livemode }`).
 */
export async function assertAboveFloor(
  amount: string,
  currency: string,
  now: Date,
  fx: FxOptions,
): Promise<void> {
  const minor = minorUnits(currency);
  if (minor === undefined) throw unsupportedCurrency(currency);
  if (currency === 'USD') {
    if (D(amount).lt(LINK_MIN_USD)) throw tooLow(D(LINK_MIN_USD).toFixed(USD_MINOR));
    return;
  }
  // "1 USD = rate <currency>": the floor in the currency is exactly rate × 1.00.
  const floor = D((await getUsdRate(currency, now, fx)).rate).mul(LINK_MIN_USD);
  if (D(amount).lt(floor)) throw tooLow(floor.toFixed(minor, Prisma.Decimal.ROUND_UP));
}

// ---------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------

interface Totals {
  paid: Dec;
  paidUsd: Dec;
  refunded: Dec;
  refundedUsd: Dec;
}

/**
 * Paid and refunded totals per link. A session counts once it has a payment with `settledAt`.
 * `session.amount` is USD (what the payer was charged); `originalAmount` is the link-currency
 * figure of a non-USD link. A merchant refund that executed (`confirmed`) returns the share
 * `refund.amount / payment.amountOut` of its payment, applied to both figures.
 */
async function totalsFor(db: ScopedDb, linkIds: string[]): Promise<Map<string, Totals>> {
  const out = new Map<string, Totals>(
    linkIds.map((id) => [id, { paid: D(0), paidUsd: D(0), refunded: D(0), refundedUsd: D(0) }]),
  );
  if (linkIds.length === 0) return out;
  const sessions = await db.session.findMany({
    where: { paymentLinkId: { in: linkIds }, payments: { some: { settledAt: { not: null } } } },
    select: {
      paymentLinkId: true,
      amount: true,
      originalAmount: true,
      payments: {
        where: { settledAt: { not: null } },
        select: { id: true, amountOut: true },
      },
    },
  });
  const paymentIds = sessions.flatMap((s) => s.payments.map((p) => p.id));
  const refunds =
    paymentIds.length === 0
      ? []
      : await db.refund.findMany({
          where: { reason: 'merchant', status: 'confirmed', paymentId: { in: paymentIds } },
          select: { paymentId: true, amount: true },
        });
  const refunded = new Map<string, Dec>();
  for (const r of refunds)
    refunded.set(r.paymentId, (refunded.get(r.paymentId) ?? D(0)).add(r.amount));

  for (const s of sessions) {
    const t = out.get(s.paymentLinkId!)!;
    const local = s.originalAmount ?? s.amount;
    t.paidUsd = t.paidUsd.add(s.amount);
    t.paid = t.paid.add(local);
    // The session was paid once; its refunds are spread over its settled payments.
    for (const p of s.payments) {
      const back = refunded.get(p.id);
      if (!back || !p.amountOut || p.amountOut.lte(0)) continue;
      const share = Prisma.Decimal.min(back.div(p.amountOut), 1);
      t.refundedUsd = t.refundedUsd.add(share.mul(s.amount));
      t.refunded = t.refunded.add(share.mul(local));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

function toView(
  link: PaymentLink,
  merchantSlug: string,
  totals: Totals,
  merchantReady: boolean,
  now: Date,
): PaymentLinkView {
  const dp = minorUnits(link.amountCurrency) ?? USD_MINOR;
  const fixed = (d: Dec | null) => (d === null ? null : d.toFixed(dp, HALF_UP));
  return {
    id: link.id,
    object: 'payment_link',
    livemode: link.livemode,
    title: link.title,
    description: link.description,
    slug: link.slug,
    ...linkUrls(merchantSlug, link.slug, link.livemode),
    amount_type: link.openAmount ? 'open' : 'fixed',
    amount: fixed(link.amount),
    currency: link.amountCurrency,
    min_amount: fixed(link.minAmount),
    note: link.noteMode,
    fee_payer: link.feePayer ? feePayerFromDb(link.feePayer) : null,
    gas_payer: link.gasSponsor === 'default' ? null : gasPayerFromDb(link.gasSponsor),
    gas_max_usd: link.gasMaxUsd === null ? null : link.gasMaxUsd.toFixed(),
    status: link.status === 'active' ? 'active' : 'inactive',
    archived: link.archivedAt !== null,
    availability: linkAvailability(link, { now, merchantReady }),
    expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
    max_uses: link.maxUses,
    use_count: link.useCount,
    total_paid: totals.paid.toFixed(dp, HALF_UP),
    total_refunded: totals.refunded.toFixed(dp, HALF_UP),
    total_paid_usd: totals.paidUsd.toFixed(USD_MINOR, HALF_UP),
    total_refunded_usd: totals.refundedUsd.toFixed(USD_MINOR, HALF_UP),
    created_at: link.createdAt.toISOString(),
    updated_at: link.updatedAt.toISOString(),
  };
}

async function viewsOf(ctx: LinkCtx, links: PaymentLink[]): Promise<PaymentLinkView[]> {
  const [merchant, readiness, totals] = await Promise.all([
    ctx.db.merchant.findFirstOrThrow({ select: { slug: true } }),
    readinessFor(ctx),
    totalsFor(
      ctx.db,
      links.map((l) => l.id),
    ),
  ]);
  const now = new Date();
  return links.map((l) => toView(l, merchant.slug, totals.get(l.id)!, readiness.ready, now));
}

async function viewOf(ctx: LinkCtx, link: PaymentLink): Promise<PaymentLinkView> {
  return (await viewsOf(ctx, [link]))[0]!;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const invalid = (field: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field });

/** The currency's minor units; USD or an ISO 4217 code in the FX table, nothing else. */
function minorOf(currency: string): number {
  const minor = minorUnits(currency);
  if (minor === undefined) throw unsupportedCurrency(currency);
  return minor;
}

/** `assertAmount` for a named field (it reports `amount`). */
function checkAmountField(value: string, minor: number, currency: string, field: string): void {
  try {
    assertAmount(value, minor, currency);
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION_ERROR') {
      throw invalid(field, err.message.replace(/^amount/, field));
    }
    throw err;
  }
}

/** Integrators that settle into their own contract take payments through hooks, not links. */
async function assertLinksSupported(ctx: LinkCtx): Promise<void> {
  const [merchant, settlement] = await Promise.all([
    ctx.db.merchant.findFirstOrThrow({ select: { kind: true } }),
    ctx.db.settlementConfig.findFirst({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: { payoutMode: true },
    }),
  ]);
  if (merchant.kind === 'integrator' && settlement?.payoutMode === 'wallet') {
    throw new AppError(
      'LINK_NOT_SUPPORTED',
      'Payment links are not available for stores that settle into their own contract',
      409,
    );
  }
}

function slugBase(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s.length >= 3 && !RESERVED_LINK_SLUGS.includes(s) ? s : 'link';
}

/** `base`, then `base-2`, `base-3`, … the first one no link of this store and mode holds. */
async function freeSlug(db: ScopedDb, base: string, skip: number): Promise<string> {
  const taken = new Set(
    (
      await db.paymentLink.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((l) => l.slug),
  );
  for (let n = skip; ; n++) {
    const suffix = n <= 1 ? '' : `-${n}`;
    const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(slug) && LINK_SLUG_RE.test(slug) && !RESERVED_LINK_SLUGS.includes(slug)) {
      return slug;
    }
  }
}

const isP2002 = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export async function createLink(ctx: LinkCtx, input: PaymentLinkCreate): Promise<PaymentLinkView> {
  await assertLinksSupported(ctx);
  const minor = minorOf(input.currency);
  const open = input.amount_type === 'open';
  if (input.amount !== undefined) checkAmountField(input.amount, minor, input.currency, 'amount');
  if (input.min_amount !== undefined) {
    checkAmountField(input.min_amount, minor, input.currency, 'min_amount');
  }
  if (input.gas_max_usd !== undefined) {
    checkAmountField(input.gas_max_usd, GAS_MAX_DECIMALS, 'USD', 'gas_max_usd');
  }
  const now = new Date();
  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  if (expiresAt && expiresAt <= now)
    throw invalid('expires_at', 'expires_at must be in the future');
  if (!open) await assertAboveFloor(input.amount!, input.currency, now, { livemode: ctx.livemode });

  const data = {
    title: input.title,
    description: input.description ?? null,
    amount: open ? null : input.amount!,
    amountCurrency: input.currency,
    openAmount: open,
    minAmount: open ? (input.min_amount ?? null) : null,
    noteMode: input.note,
    feePayer: input.fee_payer ? feePayerToDb(input.fee_payer) : null,
    gasSponsor: input.gas_payer ? gasPayerToDb(input.gas_payer) : ('default' as const),
    gasMaxUsd: input.gas_max_usd ?? null,
    maxUses: input.max_uses ?? null,
    expiresAt,
    status: input.status ?? ('active' as const),
  };

  for (let attempt = 0; ; attempt++) {
    const slug = input.slug ?? (await freeSlug(ctx.db, slugBase(input.title), 1));
    try {
      const link = await ctx.db.paymentLink.create({
        data: {
          id: newId('plink'),
          merchantId: ctx.merchantId,
          livemode: ctx.livemode,
          slug,
          ...data,
        },
      });
      return await viewOf(ctx, link);
    } catch (err) {
      if (!isP2002(err)) throw err;
      if (input.slug || attempt >= 4) throw conflict('A link with this slug already exists');
      // A generated slug lost a race: pick the next free one.
    }
  }
}

async function load(ctx: LinkCtx, id: string): Promise<PaymentLink> {
  const link = await ctx.db.paymentLink.findFirst({ where: { id } });
  if (!link) throw notFound('Payment link not found');
  return link;
}

export async function getLink(ctx: LinkCtx, id: string): Promise<PaymentLinkView> {
  return viewOf(ctx, await load(ctx, id));
}

export async function listLinks(
  ctx: LinkCtx,
  q: {
    status?: 'active' | 'inactive';
    include_archived?: boolean;
    limit: number;
    starting_after?: string;
  },
): Promise<{ data: PaymentLinkView[]; has_more: boolean }> {
  const rows = await ctx.db.paymentLink.findMany({
    where: {
      ...(q.status ? { status: q.status } : {}),
      ...(q.include_archived ? {} : { archivedAt: null }),
      ...(q.starting_after ? { id: { lt: q.starting_after } } : {}),
    },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return { data: await viewsOf(ctx, page), has_more: rows.length > q.limit };
}

export async function updateLink(
  ctx: LinkCtx,
  id: string,
  input: PaymentLinkUpdate,
): Promise<PaymentLinkView> {
  // The slug is part of the shared URL and never changes. The route schema refuses the key; refuse
  // it here too so no caller can slip it through.
  if ('slug' in input) throw invalid('slug', 'slug cannot be changed');
  const link = await load(ctx, id);

  const wasOpen = link.openAmount;
  const open = input.amount_type ? input.amount_type === 'open' : wasOpen;
  const typeChanged = open !== wasOpen;
  const currency = input.currency ?? link.amountCurrency;
  const currencyChanged = currency !== link.amountCurrency;
  const minor = minorOf(currency);

  let amount: string | null = null;
  let minAmount: string | null = null;
  if (open) {
    if (input.amount !== undefined) throw invalid('amount', 'amount is not allowed for open links');
    minAmount =
      input.min_amount !== undefined
        ? input.min_amount
        : typeChanged
          ? null
          : (link.minAmount?.toFixed() ?? null);
  } else {
    if (input.min_amount !== undefined && input.min_amount !== null) {
      throw invalid('min_amount', 'min_amount is only allowed for open links');
    }
    amount = input.amount ?? (typeChanged ? null : (link.amount?.toFixed() ?? null));
    if (amount === null) throw invalid('amount', 'amount is required for fixed links');
  }
  if (amount !== null) checkAmountField(amount, minor, currency, 'amount');
  if (minAmount !== null) checkAmountField(minAmount, minor, currency, 'min_amount');
  if (input.gas_max_usd) {
    checkAmountField(input.gas_max_usd, GAS_MAX_DECIMALS, 'USD', 'gas_max_usd');
  }
  let expiresAt: Date | null | undefined;
  if (input.expires_at !== undefined) {
    expiresAt = input.expires_at === null ? null : new Date(input.expires_at);
    if (expiresAt && expiresAt <= new Date()) {
      throw invalid('expires_at', 'expires_at must be in the future');
    }
  }
  if (amount !== null && (input.amount !== undefined || currencyChanged || typeChanged)) {
    await assertAboveFloor(amount, currency, new Date(), { livemode: ctx.livemode });
  }

  const archivedAt =
    input.archived === undefined
      ? undefined
      : input.archived
        ? (link.archivedAt ?? new Date())
        : null;
  const updated = await ctx.db.paymentLink.update({
    where: { id },
    data: {
      title: input.title,
      description: input.description === null ? null : input.description,
      amount,
      amountCurrency: currency,
      openAmount: open,
      minAmount,
      noteMode: input.note,
      feePayer:
        input.fee_payer === null
          ? null
          : input.fee_payer
            ? feePayerToDb(input.fee_payer)
            : undefined,
      gasSponsor:
        input.gas_payer === null
          ? 'default'
          : input.gas_payer
            ? gasPayerToDb(input.gas_payer)
            : undefined,
      gasMaxUsd: input.gas_max_usd,
      maxUses: input.max_uses,
      expiresAt,
      status: input.status,
      archivedAt,
    },
  });
  return viewOf(ctx, updated);
}

/** Hides a link from the default list and makes it unavailable. `updateLink(archived:false)` restores it. */
export async function archiveLink(ctx: LinkCtx, id: string): Promise<PaymentLinkView> {
  return updateLink(ctx, id, { archived: true });
}
