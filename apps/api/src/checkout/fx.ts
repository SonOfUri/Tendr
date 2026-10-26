// Non-USD order totals: FX rates and the one-time conversion to USD at session creation
// (WooCommerce plugin spec §5).
//
// RATE ORIENTATION. A rate is stored and shown the way a merchant reads it: "1 USD = R <currency>",
// e.g. `1 USD = 1602.04 NGN` is `{ currency: 'NGN', rate: '1602.04' }`. So
//     usd = amount / R, rounded UP to the cent,
// and the merchant never receives less than the order total at the quoted rate.
//
// Money math never uses floats: amounts and rates are decimal strings parsed into scaled bigints,
// and the division is an exact bigint ceiling division. Minor units come from the static ISO-4217
// table below, never from the provider.
//
// Rates are cached per currency in Redis for 60 s. A rate whose own timestamp (the provider's,
// not our fetch time) is older than 10 minutes, or any provider failure, is FX_RATE_UNAVAILABLE
// (503): there is never a fallback to a stale rate. Concurrent misses are coalesced in-process and,
// across processes, behind a short Redis lock, so a burst never stampedes the provider.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

/** How long a fetched rate is cached, per currency (seconds). */
export const FX_CACHE_TTL_S = 60;
/** A rate older than this (by its own timestamp) is never used. */
export const FX_MAX_AGE_MS = 10 * 60_000;
/** Tolerated clock skew for a provider timestamp slightly in our future. */
const FX_FUTURE_SKEW_MS = 2 * 60_000;
/** How long one process holds the cross-process fetch lock. */
const FX_LOCK_MS = 5_000;
/** How long a process waits for another process's fetch before fetching itself. */
const FX_LOCK_WAIT_MS = 2_000;
const FX_LOCK_POLL_MS = 50;
const FX_FETCH_TIMEOUT_MS = 3_000;

/**
 * ISO 4217 minor units (decimal places) for every currency a store may price in. Covers every code
 * in WooCommerce's default currency list (`get_woocommerce_currencies()`), including its few
 * non-ISO codes (marked), plus current ISO successors. A code missing here is UNSUPPORTED_CURRENCY.
 */
// prettier-ignore
export const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, AFN: 2, ALL: 2, AMD: 2, ANG: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BRL: 2,
  BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2,
  CAD: 2, CDF: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2,
  DJF: 0, DKK: 2, DOP: 2, DZD: 2,
  EGP: 2, ERN: 2, ETB: 2, EUR: 2,
  FJD: 2, FKP: 2,
  GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2,
  HKD: 2, HNL: 2, HTG: 2, HUF: 2,
  IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0,
  JMD: 2, JOD: 3, JPY: 0,
  KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2,
  LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3,
  MAD: 2, MDL: 2, MGA: 2, MKD: 2, MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2,
  MWK: 2, MXN: 2, MYR: 2, MZN: 2,
  NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2,
  OMR: 3,
  PAB: 2, PEN: 2, PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0,
  QAR: 2,
  RON: 2, RSD: 2, RUB: 2, RWF: 0,
  SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2,
  SSP: 2, STN: 2, SYP: 2, SZL: 2,
  THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2, TZS: 2,
  UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2,
  VED: 2, VES: 2, VND: 0, VUV: 0,
  WST: 2,
  XAF: 0, XCD: 2, XOF: 0, XPF: 0,
  YER: 2,
  ZAR: 2, ZMW: 2, ZWG: 2,
  // Retired ISO codes WooCommerce still lists.
  BYR: 0, CUC: 2, HRK: 2, SLL: 2, VEF: 2,
  // Non-ISO codes in WooCommerce's list: Bitcoin, the Crown-dependency pounds (GBP at par),
  // the Iranian toman, the Transnistrian ruble and the renminbi alias. Usable only if the
  // provider quotes them; otherwise FX_RATE_UNAVAILABLE.
  BTC: 8, GGP: 2, IMP: 2, JEP: 2, IRT: 0, PRB: 2, RMB: 2,
});

/** What a provider returns: `rate` is "1 USD = rate <base>"; `asOf` is the rate's own timestamp. */
export interface FxQuote {
  rate: string;
  source: string;
  asOf: Date;
}

/**
 * An FX rate source. `rate(base, 'USD')` returns how many units of `base` one USD buys
 * ("1 USD = rate <base>"), with the provider's own timestamp for that rate.
 */
export interface FxProvider {
  id: string;
  rate(base: string /* ISO-4217 */, quote: 'USD'): Promise<FxQuote>;
}

/** A rate for one currency: "1 USD = rate <currency>". */
export interface FxRate {
  currency: string;
  rate: string;
  source: string;
  asOf: Date;
}

/** A converted order total. */
export interface UsdConversion {
  /** The USD amount, 2 decimals, rounded up to the cent. */
  usd: string;
  /** The original amount, printed with the currency's minor units ("78500.00", "1000", "1.200"). */
  amount: string;
  currency: string;
  /** "1 USD = rate <currency>". */
  rate: string;
  source: string;
  asOf: Date;
}

// ---------------------------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------------------------

interface Exact {
  /** value = digits / 10^scale */
  digits: bigint;
  scale: number;
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;
/** A provider number: an exact decimal, optionally in exponent notation ("2.5e4"). */
const PROVIDER_NUMBER_RE = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** Bounds a provider exponent so a hostile "1e999999999" cannot allocate a huge string. */
const MAX_PROVIDER_EXPONENT = 40;
/** Rates are stored in `Decimal(38, 18)`: at most 20 integer and 18 fraction digits. */
const RATE_MAX_INT_DIGITS = 20;
const RATE_MAX_SCALE = 18;

function parseExact(s: string): Exact | null {
  const m = DECIMAL_RE.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  return { digits: BigInt(m[1]! + frac), scale: frac.length };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Expands a provider number ("2.5e4", "1602.040") into a plain decimal string, exactly. */
function plainDecimal(text: string): string | null {
  const m = PROVIDER_NUMBER_RE.exec(text);
  if (!m) return null;
  let int = m[1]!;
  let frac = m[2] ?? '';
  const exp = m[3] === undefined ? 0 : Number.parseInt(m[3], 10);
  if (exp > MAX_PROVIDER_EXPONENT || exp < -MAX_PROVIDER_EXPONENT) return null;
  if (exp > 0) {
    frac = frac.padEnd(exp, '0');
    int += frac.slice(0, exp);
    frac = frac.slice(exp);
  } else if (exp < 0) {
    int = int.padStart(-exp + 1, '0');
    frac = int.slice(int.length + exp) + frac;
    int = int.slice(0, int.length + exp);
  }
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** A provider rate we can store and divide by: positive, within `Decimal(38, 18)`. */
function validRate(rate: unknown): rate is string {
  if (typeof rate !== 'string') return false;
  const m = DECIMAL_RE.exec(rate);
  if (!m) return false;
  if ((m[2] ?? '').length > RATE_MAX_SCALE) return false;
  if (m[1]!.replace(/^0+/, '').length > RATE_MAX_INT_DIGITS) return false;
  return /[1-9]/.test(rate);
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

/** Decimal places of `currency`, or undefined when it is not in the table. */
export function minorUnits(currency: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(ISO_4217_MINOR_UNITS, currency)
    ? ISO_4217_MINOR_UNITS[currency]
    : undefined;
}

export function unsupportedCurrency(currency: string, settlementAsset?: string): AppError {
  return new AppError(
    'UNSUPPORTED_CURRENCY',
    settlementAsset
      ? `amount_currency must be an ISO 4217 currency code or the settlement asset (${settlementAsset})`
      : `${currency} is not a supported ISO 4217 currency code`,
    400,
    settlementAsset ? { allowed: ['ISO 4217 code', settlementAsset] } : { currency },
  );
}

const amountInvalid = (message: string) =>
  new AppError('VALIDATION_ERROR', message, 400, { field: 'amount' });

/**
 * Converts `amount` of `currency` to USD at `rate` ("1 USD = rate.rate <currency>"):
 * `usd = ceil(amount / rate)` to the cent, exactly, in bigint.
 *
 * With amount = A / 10^a and rate = R / 10^r, the USD amount in cents is
 *     ceil((A × 10^r × 100) / (R × 10^a)).
 *
 * Throws UNSUPPORTED_CURRENCY for a code outside the ISO table, VALIDATION_ERROR for an amount
 * that is not a positive decimal or has more decimals than the currency's minor units.
 */
export function convertToUsd(amount: string, currency: string, rate: FxRate): UsdConversion {
  const minor = minorUnits(currency);
  if (minor === undefined) throw unsupportedCurrency(currency);
  if (rate.currency !== currency) {
    throw new Error(`convertToUsd: a rate for ${rate.currency} cannot convert ${currency}`);
  }
  const a = parseExact(amount);
  if (!a) throw amountInvalid('amount must be a decimal string like "25.10"');
  if (a.scale > minor) {
    throw amountInvalid(`amount in ${currency} allows at most ${minor} decimal places`);
  }
  if (a.digits === 0n) throw amountInvalid('amount must be greater than 0');
  const r = validRate(rate.rate) ? parseExact(rate.rate) : null;
  if (!r) throw new Error(`convertToUsd: invalid rate "${rate.rate}"`);

  const cents = ceilDiv(
    a.digits * 10n ** BigInt(r.scale) * 100n,
    r.digits * 10n ** BigInt(a.scale),
  );
  const usd = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;

  const [int, frac = ''] = amount.split('.');
  const normalized = minor > 0 ? `${int}.${frac.padEnd(minor, '0')}` : int!;
  return {
    usd,
    amount: normalized,
    currency,
    rate: rate.rate,
    source: rate.source,
    asOf: rate.asOf,
  };
}

// ---------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------

const fixedProvider: FxProvider = {
  id: 'fixed',
  /**
   * Rates from `FX_FIXED_RATES` (JSON `{"NGN":"1602.04"}`, "1 USD = R <code>"). A fixed table is
   * current by definition, so `asOf` is the time of the call. Tests and test mode only.
   */
  async rate(base) {
    const rate = env().FX_FIXED_RATES[base];
    if (rate === undefined) throw new Error(`FX_FIXED_RATES has no rate for ${base}`);
    return { rate, source: 'fixed', asOf: new Date() };
  },
};

/** The fixed-rate provider (`FX_FIXED_RATES`). */
export function fixedFxProvider(): FxProvider {
  return fixedProvider;
}

type ReviverWithSource = (key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * Parses JSON keeping every number as its exact source text (Node 22's `JSON.parse` source
 * access), so a rate like `1602.0400000000001` is never rounded through a float.
 */
function parseJsonExact(text: string): unknown {
  const reviver: ReviverWithSource = (_key, value, context) =>
    typeof value === 'number' && typeof context?.source === 'string' ? context.source : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

const OXR_URL = 'https://openexchangerates.org/api/latest.json';

/**
 * Open Exchange Rates (`latest.json`, USD base): `rates[<code>]` is already "1 USD = R <code>".
 * `asOf` is the response's `timestamp` (the rate's own time, unix seconds); a response without one
 * is refused. The app id is sent as the `app_id` query parameter and never logged.
 */
export function openExchangeRatesProvider(apiKey: string): FxProvider {
  return {
    id: 'openexchangerates',
    async rate(base) {
      const url = new URL(OXR_URL);
      url.searchParams.set('app_id', apiKey);
      url.searchParams.set('symbols', base);
      const res = await globalThis.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`openexchangerates returned HTTP ${res.status}`);
      const body = parseJsonExact(await res.text());
      if (typeof body !== 'object' || body === null) {
        throw new Error('openexchangerates returned a non-object body');
      }
      const { timestamp, base: rateBase, rates } = body as Record<string, unknown>;
      if (rateBase !== 'USD') throw new Error('openexchangerates returned another base');
      if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) {
        throw new Error('openexchangerates returned no timestamp');
      }
      const raw =
        typeof rates === 'object' && rates !== null
          ? (rates as Record<string, unknown>)[base]
          : undefined;
      const rate = typeof raw === 'string' ? plainDecimal(raw) : null;
      if (rate === null) throw new Error(`openexchangerates returned no rate for ${base}`);
      return {
        rate,
        source: 'openexchangerates',
        asOf: new Date(Number.parseInt(timestamp, 10) * 1000),
      };
    },
  };
}

/** The provider for a mode: test mode always uses `fixed`; live mode uses `FX_PROVIDER`. */
export function fxProviderFor(livemode: boolean): FxProvider {
  const e = env();
  if (!livemode || e.FX_PROVIDER === 'fixed') return fixedProvider;
  return openExchangeRatesProvider(e.FX_API_KEY ?? '');
}

// ---------------------------------------------------------------------------------------------
// Cached rates
// ---------------------------------------------------------------------------------------------

/** Tests get a private keyspace per process so runs never share cached rates. */
const PREFIX = process.env.NODE_ENV === 'test' ? `tendr:fx:test:${randomUUID()}:` : 'tendr:fx:';

export const fxCacheKey = (providerId: string, currency: string) =>
  `${PREFIX}${providerId}:${currency}`;
export const fxLockKey = (providerId: string, currency: string) =>
  `${PREFIX}lock:${providerId}:${currency}`;

/** In-process single-flight: one provider call per (provider, currency) at a time. */
const inflight = new Map<string, Promise<FxRate>>();

export function fxUnavailable(currency: string): AppError {
  return new AppError(
    'FX_RATE_UNAVAILABLE',
    `No current exchange rate for ${currency} is available; try again shortly`,
    503,
    { currency },
  );
}

export interface FxOptions {
  livemode: boolean;
  /** Defaults to `fxProviderFor(livemode)`. */
  provider?: FxProvider;
  /** Defaults to the process-wide client. */
  redis?: Redis;
}

async function readCache(redis: Redis, key: string, currency: string): Promise<FxRate | null> {
  let text: string | null;
  try {
    text = await redis.get(key);
  } catch (err) {
    // The cache is an optimisation: with Redis down, fetch (still coalesced in-process).
    log('warn', 'fx cache read failed', { err: String(err) });
    return null;
  }
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { rate?: unknown; source?: unknown; asOf?: unknown };
    const asOf = typeof v.asOf === 'string' ? new Date(v.asOf) : null;
    if (!validRate(v.rate) || typeof v.source !== 'string' || !asOf || isNaN(asOf.getTime())) {
      return null;
    }
    return { currency, rate: v.rate, source: v.source, asOf };
  } catch {
    return null;
  }
}

async function writeCache(redis: Redis, key: string, rate: FxRate): Promise<void> {
  try {
    await redis.set(
      key,
      JSON.stringify({ rate: rate.rate, source: rate.source, asOf: rate.asOf.toISOString() }),
      'EX',
      FX_CACHE_TTL_S,
    );
  } catch (err) {
    log('warn', 'fx cache write failed', { err: String(err) });
  }
}

const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Fetches one rate behind the cross-process lock, then caches it. */
async function fetchRate(redis: Redis, provider: FxProvider, currency: string): Promise<FxRate> {
  const key = fxCacheKey(provider.id, currency);
  const lockKey = fxLockKey(provider.id, currency);
  const token = randomUUID();
  let locked = false;
  let redisUp = true;
  try {
    locked = (await redis.set(lockKey, token, 'PX', FX_LOCK_MS, 'NX')) === 'OK';
  } catch {
    redisUp = false; // Redis down: fetch at once, without the lock (still coalesced in-process).
  }
  if (!locked && redisUp) {
    // Another process is fetching this rate: wait for its result rather than call the provider.
    for (let waited = 0; waited < FX_LOCK_WAIT_MS; waited += FX_LOCK_POLL_MS) {
      await new Promise((r) => setTimeout(r, FX_LOCK_POLL_MS));
      const cached = await readCache(redis, key, currency);
      if (cached) return cached;
    }
    // The holder died or is slow: fetch ourselves.
  }
  try {
    let quote: FxQuote;
    try {
      quote = await provider.rate(currency, 'USD');
    } catch (err) {
      log('warn', 'fx provider failed', { provider: provider.id, currency, err: String(err) });
      throw fxUnavailable(currency);
    }
    const asOf = quote.asOf;
    if (
      !validRate(quote.rate) ||
      typeof quote.source !== 'string' ||
      !(asOf instanceof Date) ||
      isNaN(asOf.getTime())
    ) {
      log('warn', 'fx provider returned an unusable rate', { provider: provider.id, currency });
      throw fxUnavailable(currency);
    }
    const rate: FxRate = { currency, rate: quote.rate, source: quote.source, asOf };
    await writeCache(redis, key, rate);
    return rate;
  } finally {
    if (locked) await redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
  }
}

/**
 * The USD rate of `currency` ("1 USD = rate <currency>"), from the 60 s cache or the mode's
 * provider. Throws FX_RATE_UNAVAILABLE (503) when the provider fails or the rate's own timestamp
 * is more than 10 minutes before `now` (cached or not: never a stale fallback), and
 * UNSUPPORTED_CURRENCY for a code outside the ISO table.
 */
export async function getUsdRate(currency: string, now: Date, opts: FxOptions): Promise<FxRate> {
  if (minorUnits(currency) === undefined) throw unsupportedCurrency(currency);
  const provider = opts.provider ?? fxProviderFor(opts.livemode);
  const redis = opts.redis ?? getRedis();
  const key = fxCacheKey(provider.id, currency);

  let rate = await readCache(redis, key, currency);
  if (!rate) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchRate(redis, provider, currency).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    rate = await pending;
  }
  const age = now.getTime() - rate.asOf.getTime();
  if (age > FX_MAX_AGE_MS || age < -FX_FUTURE_SKEW_MS) throw fxUnavailable(currency);
  return rate;
}

/** Test helper: drops cached rates and locks in this process's keyspace. */
export async function resetFxCache(redis: Redis = getRedis()): Promise<void> {
  inflight.clear();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}
