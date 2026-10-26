// A merchant's checkout settings (dashboard, checkout Task 10): the checkout domains — origins
// allowed to frame the checkout (CSP `frame-ancestors`), shared by test and live — and the default
// fee and gas payers. Merchant-level, not per mode.
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
import { z } from 'zod';
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { AppError, notFound } from '../lib/errors.js';
import { LOCAL_DEV_HOSTS } from '../lib/local-hosts.js';
import { prisma } from '../lib/prisma.js';

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
  })
  .strict();

type Settings = {
  checkoutDomains: string[];
  defaultFeePayer: Parameters<typeof feePayerFromDb>[0];
  defaultGasPayer: Parameters<typeof gasPayerFromDb>[0];
};

const view = (m: Settings) => ({
  checkout_domains: m.checkoutDomains,
  default_fee_payer: feePayerFromDb(m.defaultFeePayer),
  default_gas_payer: gasPayerFromDb(m.defaultGasPayer),
});

const SELECT = { checkoutDomains: true, defaultFeePayer: true, defaultGasPayer: true } as const;

export async function getCheckoutSettings(ctx: ScopeContext) {
  const m = await prisma.merchant.findUnique({ where: { id: ctx.merchantId }, select: SELECT });
  if (!m) throw notFound('Store not found');
  return view(m);
}

/**
 * Updates the given fields (merchant-wide) and records an internal audit event in the caller's
 * mode with the before and after values.
 */
export async function updateCheckoutSettings(
  ctx: ScopeContext,
  actorUserId: string,
  input: z.infer<typeof CheckoutSettingsPatchSchema>,
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
      },
      select: SELECT,
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'merchant',
      aggregateId: ctx.merchantId,
      type: CHECKOUT_SETTINGS_UPDATED,
      payload: { user_id: actorUserId, before: view(before), after: view(after) },
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
