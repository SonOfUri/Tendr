// Payment links, public side (spec §5): what the payer's page reads, and "Pay", which creates a
// checkout session from the link.
//
// A link is addressed by merchant slug, link slug and mode (`?mode=test` picks test mode). An
// unknown merchant, a merchant that cannot trade, and an unknown link are one and the same 404, so
// the address never says whether a store exists. The read returns only what the page shows: no
// ids, use counts or limits. Neither function needs a credential; the routes rate-limit them.
import { Prisma, type FeePayer as DbFeePayer, type PaymentLink } from '@prisma/client';
import {
  LINK_MIN_USD,
  cleanPayerNote,
  feePayerFromDb,
  maskAddressLike,
  type PaymentLinkAvailability,
  type PublicLinkSessionCreated,
  type PublicLinkSessionInput,
  type PublicPaymentLinkView,
} from '@tendr/contracts';
import { getUsdRate, minorUnits } from '../checkout/fx.js';
import {
  LINK_MAX_QUOTED_SESSIONS,
  assertAmount,
  createSession,
  linkUnavailable,
  readinessFor,
  type CheckoutCtx,
} from '../checkout/sessions.js';
import { scopedDb } from '../db/scoped.js';
import { AppError, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { resolveShopperTheme } from '../themes/resolve.js';
import { assertAboveFloor, linkAvailability, linkUrls } from './links.js';

export { LINK_MAX_QUOTED_SESSIONS };

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const USD_MINOR = 2;
/** Decimal digits only: no sign, separators or exponent. Precision is checked per currency. */
const AMOUNT_RE = /^\d+(?:\.\d+)?$/;

const linkNotFound = () => notFound('Payment link not found');

interface Resolved {
  ctx: CheckoutCtx;
  merchant: { name: string; slug: string; defaultFeePayer: DbFeePayer };
  link: PaymentLink;
}

async function resolve(
  merchantSlug: string,
  linkSlug: string,
  livemode: boolean,
): Promise<Resolved> {
  const merchant = await prisma.merchant.findUnique({
    where: { slug: merchantSlug },
    select: { id: true, name: true, slug: true, status: true, defaultFeePayer: true },
  });
  if (!merchant || merchant.status !== 'active') throw linkNotFound();
  const db = scopedDb({ merchantId: merchant.id, livemode });
  const link = await db.paymentLink.findFirst({ where: { slug: linkSlug } });
  if (!link) throw linkNotFound();
  return { ctx: { merchantId: merchant.id, livemode, db, connectionId: null }, merchant, link };
}

/** What the page may say: an archived link reads like a switched-off one (spec §2.3). */
const publicAvailability = (a: PaymentLinkAvailability): PaymentLinkAvailability =>
  a === 'archived' ? 'inactive' : a;

async function availabilityOf(r: Resolved, now: Date): Promise<PaymentLinkAvailability> {
  const readiness = await readinessFor(r.ctx);
  return linkAvailability(r.link, { now, merchantReady: readiness.ready });
}

/** "1 USD = rate <currency>", or null when the provider has no current rate. */
async function usdRate(currency: string, now: Date, livemode: boolean): Promise<string | null> {
  try {
    return (await getUsdRate(currency, now, { livemode })).rate;
  } catch (err) {
    if (err instanceof AppError && err.code === 'FX_RATE_UNAVAILABLE') return null;
    throw err;
  }
}

/**
 * The lowest amount an open link takes: the larger of the link's `min_amount` and the USD 1.00
 * floor in the link's currency (`rate` = "1 USD = rate"), rounded UP to the currency's minor
 * units. Without a rate only the link's own minimum is known (null when it has none).
 */
function effectiveMin(link: PaymentLink, rate: string | null, minor: number): string | null {
  const floor =
    link.amountCurrency === 'USD' ? D(LINK_MIN_USD) : rate ? D(rate).mul(LINK_MIN_USD) : null;
  const own = link.minAmount;
  const min = floor && own ? Prisma.Decimal.max(floor, own) : (floor ?? own);
  return min ? min.toFixed(minor, Prisma.Decimal.ROUND_UP) : null;
}

const minorOf = (currency: string) => minorUnits(currency) ?? USD_MINOR;

/** The payer page's view of a link. NOT_FOUND (404) for an unknown merchant or link. */
export async function getPublicLink(
  merchantSlug: string,
  linkSlug: string,
  livemode: boolean,
): Promise<PublicPaymentLinkView> {
  const r = await resolve(merchantSlug, linkSlug, livemode);
  const { link } = r;
  const now = new Date();
  const minor = minorOf(link.amountCurrency);
  const [availability, rate, theme] = await Promise.all([
    availabilityOf(r, now),
    link.amountCurrency === 'USD' ? null : usdRate(link.amountCurrency, now, livemode),
    resolveShopperTheme(r.ctx.db, {
      merchantId: r.ctx.merchantId,
      merchantName: r.merchant.name,
      themeId: link.themeId,
      livemode,
      kind: 'link',
      link: { title: link.title, description: link.description },
    }),
  ]);
  // Text saved before the address rule existed is masked on the way out.
  return {
    merchant: { name: r.merchant.name },
    theme,
    title: maskAddressLike(link.title),
    description: link.description === null ? null : maskAddressLike(link.description),
    amount_type: link.openAmount ? 'open' : 'fixed',
    amount: link.amount === null ? null : link.amount.toFixed(minor),
    currency: link.amountCurrency,
    minor_units: minor,
    min_amount: link.openAmount ? effectiveMin(link, rate, minor) : null,
    usd_rate: rate,
    note: link.noteMode,
    fee_payer: feePayerFromDb(link.feePayer ?? r.merchant.defaultFeePayer),
    availability: publicAvailability(availability),
    livemode,
  };
}

const tooLow = (min: string, currency: string) =>
  new AppError('AMOUNT_TOO_LOW', `The amount must be at least ${min} ${currency}`, 400, {
    field: 'amount',
    min_amount: min,
  });

const amountInvalid = (message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field: 'amount' });

/**
 * The payer pressed "Pay": re-checks the link at this instant, prices the amount (a fixed link's
 * own, re-checked against the USD 1.00 floor at the current rate; an open link's typed amount,
 * checked for precision and against the effective minimum), cleans the note, and creates the
 * session through `createSession` with no `external_ref` and the link page as the return address.
 * Returns the hosted checkout URL with the client secret in its fragment, and the session's expiry.
 *
 * NOT_FOUND (404); LINK_UNAVAILABLE (409, `details.availability`); LINK_RESERVED (409);
 * LINK_BUSY (429); AMOUNT_TOO_LOW (400, `details.min_amount`); VALIDATION_ERROR (400);
 * FX_RATE_UNAVAILABLE (503). `ip` is the payer's address, for the log line when a link is busy.
 */
export async function createLinkSession(
  merchantSlug: string,
  linkSlug: string,
  livemode: boolean,
  input: PublicLinkSessionInput,
  ip: string,
): Promise<PublicLinkSessionCreated> {
  const r = await resolve(merchantSlug, linkSlug, livemode);
  const { link } = r;
  const now = new Date();
  // Checked again under the link's row lock in createSession; this one also catches a store that
  // is not ready, which createSession would report as ACCOUNT_NOT_READY.
  const availability = await availabilityOf(r, now);
  if (availability !== 'available') throw linkUnavailable(availability, true);

  const currency = link.amountCurrency;
  const minor = minorOf(currency);
  let amount: string;
  if (!link.openAmount) {
    // Rates move: a fixed price worth USD 1.00 when it was set may be worth less now.
    amount = link.amount!.toFixed(minor);
    await assertAboveFloor(amount, currency, now, { livemode });
  } else {
    const typed = input.amount?.trim() ?? '';
    if (!AMOUNT_RE.test(typed)) throw amountInvalid('amount must be a number like "2500.50"');
    assertAmount(typed, minor, currency);
    const rate = currency === 'USD' ? null : (await getUsdRate(currency, now, { livemode })).rate;
    const min = effectiveMin(link, rate, minor)!;
    if (D(typed).lt(min)) throw tooLow(min, currency);
    amount = typed;
  }

  const payerNote = link.noteMode === 'off' ? null : cleanPayerNote(input.note);
  const returnUrl = linkUrls(r.merchant.slug, link.slug, livemode).url;
  try {
    const created = await createSession(
      r.ctx,
      { amount, amount_currency: currency, success_url: returnUrl, cancel_url: returnUrl },
      { fromLink: { linkId: link.id, payerNote, returnUrl } },
    );
    return { url: created.url, expires_at: created.expires_at };
  } catch (err) {
    if (err instanceof AppError && err.code === 'LINK_BUSY') {
      log('warn', 'payment link busy', { linkId: link.id, ip });
    }
    throw err;
  }
}
