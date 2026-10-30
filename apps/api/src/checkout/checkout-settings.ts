// A merchant's checkout settings (dashboard, checkout Task 10): the checkout domains — origins
// allowed to frame the checkout (CSP `frame-ancestors`), shared by test and live — the default
// fee and gas payers, the store's notification email and the "You got paid" switch. Merchant-level,
// not per mode. A connected site's key changes only the payers and the notification email.
//
// A checkout domain is an ORIGIN: scheme + host + optional port, no path, query, fragment,
// credentials or wildcard. `https://` only in production; outside production `http://localhost`
// (and 127.0.0.1 / [::1]) is also allowed for local development. At most MAX_CHECKOUT_DOMAINS,
// deduplicated after normalisation (lower-case host, default port dropped, trailing `/` ignored).
import {
  FeePayerSchema,
  feePayerFromDb,
  feePayerToDb,
  GasPayerSchema,
  gasPayerFromDb,
  gasPayerToDb,
  MAX_CHECKOUT_DOMAINS,
} from '@tendr/contracts';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { EmailSchema } from '../auth/magic-link.js';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { ensureDefaultGasPolicy } from '../gas/policy.js';
import { AppError, notFound } from '../lib/errors.js';
import { LOCAL_DEV_HOSTS } from '../lib/local-hosts.js';
import { prisma } from '../lib/prisma.js';
import {
  clearNotificationEmail,
  endPending,
  PENDING_SELECT,
  requestNotificationEmail,
  type SettingsActor,
} from '../merchants/notification-email.js';

/** Internal audit event (never a webhook). */
export const CHECKOUT_SETTINGS_UPDATED = 'merchant.checkout_settings.updated';

const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

/**
 * Normalises one checkout domain to its origin, or returns an error message. `production` decides
 * whether `http://localhost` is accepted.
 */
export function normalizeCheckoutDomain(
  raw: string,
  production: boolean,
): { origin: string } | { error: string } {
  const value = raw.trim();
  if (value.includes('*')) return { error: 'wildcards are not allowed' };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { error: 'not a URL (use an origin like https://shop.example)' };
  }
  if (u.username || u.password) return { error: 'credentials are not allowed' };
  if (u.pathname !== '/' || u.search || u.hash || /[?#]/.test(value)) {
    return { error: 'use an origin only, without a path, query or fragment' };
  }
  // `https://shop.example/x/..` normalises to `/`; only an empty path or a single `/` is an origin.
  const afterHost = value.slice(value.indexOf('//') + 2);
  const slash = afterHost.indexOf('/');
  if (slash >= 0 && afterHost.slice(slash) !== '/') {
    return { error: 'use an origin only, without a path, query or fragment' };
  }
  if (u.protocol === 'https:') return { origin: u.origin };
  if (u.protocol === 'http:' && !production && LOCAL_DEV_HOSTS.has(u.hostname)) {
    return { origin: u.origin };
  }
  return {
    error: production ? 'must start with https://' : 'must use https:// (or http://localhost)',
  };
}

/** Validates and normalises a full list (dedupe, then the size limit). Throws 400 on any error. */
export function validateCheckoutDomains(list: string[], production: boolean): string[] {
  const out: string[] = [];
  const errors: { index: number; value: string; error: string }[] = [];
  list.forEach((raw, index) => {
    const r = normalizeCheckoutDomain(raw, production);
    if ('error' in r) errors.push({ index, value: raw, error: r.error });
    else if (!out.includes(r.origin)) out.push(r.origin);
  });
  if (errors.length > 0) {
    throw invalid(`Invalid checkout domain: ${errors[0]!.value} (${errors[0]!.error})`, {
      field: 'checkout_domains',
      errors,
    });
  }
  if (out.length > MAX_CHECKOUT_DOMAINS) {
    throw invalid(`At most ${MAX_CHECKOUT_DOMAINS} checkout domains`, {
      field: 'checkout_domains',
    });
  }
  return out;
}

export const CheckoutSettingsPatchSchema = z
  .object({
    checkout_domains: z.array(z.string().max(300)).max(200).optional(),
    default_fee_payer: FeePayerSchema.optional(),
    default_gas_payer: GasPayerSchema.optional(),
    /** A new address only takes effect through its verify link; null → the owners' emails. */
    notification_email: EmailSchema.nullable().optional(),
    payment_emails_enabled: z.boolean().optional(),
  })
  .strict();
export type CheckoutSettingsPatch = z.infer<typeof CheckoutSettingsPatchSchema>;

/** The settings a connected site's key may change (spec §3); anything else is FIELD_NOT_ALLOWED. */
export const CONNECTION_SETTINGS_FIELDS: readonly string[] = [
  'default_fee_payer',
  'default_gas_payer',
  'notification_email',
];

/**
 * Refuses (403 FIELD_NOT_ALLOWED) a connection-key body naming any setting outside
 * CONNECTION_SETTINGS_FIELDS. Checked on the raw body, before validation, so a refused field is
 * always 403 whatever its value; unknown keys still fail validation (400).
 */
export function assertConnectionFields(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const known = Object.keys(CheckoutSettingsPatchSchema.shape);
  const refused = Object.keys(body).filter(
    (k) => known.includes(k) && !CONNECTION_SETTINGS_FIELDS.includes(k),
  );
  if (refused.length > 0) {
    throw new AppError(
      'FIELD_NOT_ALLOWED',
      `A connected site can change only ${CONNECTION_SETTINGS_FIELDS.join(', ')}`,
      403,
      { fields: refused },
    );
  }
}

const SELECT = {
  name: true,
  checkoutDomains: true,
  defaultFeePayer: true,
  defaultGasPayer: true,
  notificationEmail: true,
  notificationEmailPending: true,
  paymentEmailsEnabled: true,
} as const;
type Settings = Prisma.MerchantGetPayload<{ select: typeof SELECT }>;

const view = (m: Settings) => ({
  checkout_domains: m.checkoutDomains,
  default_fee_payer: feePayerFromDb(m.defaultFeePayer),
  default_gas_payer: gasPayerFromDb(m.defaultGasPayer),
  notification_email: m.notificationEmail,
  notification_email_pending: m.notificationEmailPending,
  payment_emails_enabled: m.paymentEmailsEnabled,
});

export async function getCheckoutSettings(ctx: ScopeContext) {
  const m = await prisma.merchant.findUnique({ where: { id: ctx.merchantId }, select: SELECT });
  if (!m) throw notFound('Store not found');
  return view(m);
}

/**
 * Updates the given fields (merchant-wide) and records an internal audit event in the caller's
 * mode with who made the change and the before and after values. A `notification_email` change
 * only starts a pending one (a verify link to the new address, a warning to the current one);
 * null (back to the owners) or the current address applies at once and drops any pending change,
 * and clearing an address tells it. Those mails go out after commit (event handlers).
 */
export async function updateCheckoutSettings(
  ctx: ScopeContext,
  actor: SettingsActor,
  input: CheckoutSettingsPatch,
) {
  const production = env().NODE_ENV === 'production';
  const domains =
    input.checkout_domains === undefined
      ? undefined
      : validateCheckoutDomains(input.checkout_domains, production);
  return tenantTransaction(ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${ctx.merchantId} FOR UPDATE`;
    const before = await tx.merchant.findUnique({ where: { id: ctx.merchantId }, select: SELECT });
    if (!before) throw notFound('Store not found');

    // Mail is never sent here (W16.3): the helpers record events whose handlers mail after
    // commit, so a mail failure never rolls back this change (payer changes included).
    let email: Prisma.MerchantUncheckedUpdateInput = {};
    if (input.notification_email !== undefined) {
      const row = await tx.merchant.findUniqueOrThrow({
        where: { id: ctx.merchantId },
        select: PENDING_SELECT,
      });
      if (input.notification_email === null) {
        email = await clearNotificationEmail(tx, ctx, row, actor);
      } else if (input.notification_email === before.notificationEmail) {
        email = await endPending(tx, row);
      } else {
        email = await requestNotificationEmail(tx, ctx, row, input.notification_email, actor);
      }
    }

    const after = await tx.merchant.update({
      where: { id: ctx.merchantId },
      data: {
        ...(domains !== undefined ? { checkoutDomains: domains } : {}),
        ...(input.default_fee_payer
          ? { defaultFeePayer: feePayerToDb(input.default_fee_payer) }
          : {}),
        ...(input.default_gas_payer
          ? { defaultGasPayer: gasPayerToDb(input.default_gas_payer) }
          : {}),
        ...(input.payment_emails_enabled !== undefined
          ? { paymentEmailsEnabled: input.payment_emails_enabled }
          : {}),
        ...email,
      },
      select: SELECT,
    });
    // Merchant-paid gas needs a policy (gasless spec §8.4, ruling R1-3): the caller's mode gets the
    // enabled defaults unless it already has one.
    if (input.default_gas_payer === 'merchant') await ensureDefaultGasPolicy(tx, ctx, actor);
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant',
      aggregateId: ctx.merchantId,
      type: CHECKOUT_SETTINGS_UPDATED,
      payload: {
        actor,
        ...(actor.by === 'user' ? { user_id: actor.userId } : {}),
        before: view(before),
        after: view(after),
      },
    });
    return view(after);
  });
}

/** A session id as the gateway issues them (`ses_` + ULID); anything else is not looked up. */
const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The origins allowed to frame session `sessionId`'s checkout page (the web middleware builds CSP
 * `frame-ancestors` from it). Public: returns the merchant's checkout domains and nothing else.
 * Empty, never an error, for an unknown or malformed id, so the answer never confirms more than a
 * framed page load would. Any existing session keeps its origins, expired ones included (C28): an
 * expired checkout still shows a late deposit, a hold or a refund.
 */
export async function publicFrameOrigins(sessionId: string): Promise<{ origins: string[] }> {
  if (!SESSION_ID.test(sessionId)) return { origins: [] };
  const s = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { merchant: { select: { checkoutDomains: true } } },
  });
  return { origins: s ? [...s.merchant.checkoutDomains] : [] };
}
