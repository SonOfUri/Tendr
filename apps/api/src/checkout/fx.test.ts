import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, loadEnv } from '../env.js';
import { AppError } from '../lib/errors.js';
import { closeClient, createRedis, whenReady } from '../lib/redis.js';
import {
  FX_CACHE_TTL_S,
  FX_MAX_AGE_MS,
  ISO_4217_MINOR_UNITS,
  convertToUsd,
  fixedFxProvider,
  fxCacheKey,
  fxLockKey,
  fxProviderFor,
  getUsdRate,
  openExchangeRatesProvider,
  resetFxCache,
  type FxProvider,
  type FxRate,
} from './fx.js';

const MIN = 60_000;

// Provider failures log a warning; keep the test output clean.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const rateOf = (currency: string, rate: string, asOf = new Date()): FxRate => ({
  currency,
  rate,
  source: 'fixed',
  asOf,
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : 'not-app-error';
  }
  return undefined;
}

async function rejectionOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('convertToUsd', () => {
  it('reads the rate the way a merchant does: 1 USD = 1602.04 NGN', () => {
    // Doc example (README, API docs): NGN 1602.04 is exactly USD 1.00 at this rate.
    expect(convertToUsd('1602.04', 'NGN', rateOf('NGN', '1602.04')).usd).toBe('1.00');
    // EUR at 1 USD = 0.92 EUR: EUR 92.00 is USD 100.00.
    expect(convertToUsd('92.00', 'EUR', rateOf('EUR', '0.92')).usd).toBe('100.00');
  });

  it('NGN 78500.00 at 1 USD = 1602.04 NGN → USD 49.01 (rounded up)', () => {
    const c = convertToUsd('78500.00', 'NGN', rateOf('NGN', '1602.04'));
    expect(c.usd).toBe('49.01');
    expect(c).toMatchObject({ amount: '78500.00', currency: 'NGN', rate: '1602.04' });
  });

  it('rounds up only when there is a remainder', () => {
    expect(convertToUsd('1602.05', 'NGN', rateOf('NGN', '1602.04')).usd).toBe('1.01');
    expect(convertToUsd('3204.08', 'NGN', rateOf('NGN', '1602.04')).usd).toBe('2.00');
    // The smallest amount still costs at least one cent.
    expect(convertToUsd('0.01', 'NGN', rateOf('NGN', '1602.04')).usd).toBe('0.01');
  });

  it('JPY 1000 (0 dp) converts exactly', () => {
    expect(convertToUsd('1000', 'JPY', rateOf('JPY', '125')).usd).toBe('8.00');
    // 1000 / 151.5 = 6.6006…, rounded up.
    expect(convertToUsd('1000', 'JPY', rateOf('JPY', '151.5')).usd).toBe('6.61');
    expect(codeOf(() => convertToUsd('1000.5', 'JPY', rateOf('JPY', '151.5')))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('KWD 1.234 (3 dp) accepted; KWD 1.2345 rejected', () => {
    // 1.234 / 0.307 = 4.0195…, rounded up.
    expect(convertToUsd('1.234', 'KWD', rateOf('KWD', '0.307')).usd).toBe('4.02');
    expect(codeOf(() => convertToUsd('1.2345', 'KWD', rateOf('KWD', '0.307')))).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('refuses a currency outside the table, and a rate for another currency', () => {
    expect(codeOf(() => convertToUsd('1', 'XYZ', rateOf('XYZ', '1')))).toBe('UNSUPPORTED_CURRENCY');
    expect(() => convertToUsd('1', 'EUR', rateOf('NGN', '1602.04'))).toThrow(/rate for NGN/);
  });

  it('no float arithmetic: 1000 random amounts match a bigint reference', () => {
    // Deterministic PRNG (mulberry32) so a failure reproduces.
    let seed = 0x7e4d2;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');
    const currencies = ['NGN', 'JPY', 'KWD', 'EUR', 'IDR', 'BHD', 'KRW'];

    for (let i = 0; i < 1000; i++) {
      const currency = currencies[i % currencies.length]!;
      const minor = ISO_4217_MINOR_UNITS[currency]!;
      // Up to 20 integer digits: far past 2^53, where a float division would go wrong.
      const int = `${1 + Math.floor(rand() * 9)}${digits(Math.floor(rand() * 20))}`;
      const fracLen = Math.floor(rand() * (minor + 1));
      const amount = fracLen ? `${int}.${digits(fracLen)}` : int;
      const rate = `${1 + Math.floor(rand() * 9)}${digits(Math.floor(rand() * 5))}.${digits(1 + Math.floor(rand() * 8))}`;

      const usd = convertToUsd(amount, currency, rateOf(currency, rate)).usd;

      // Reference: the least whole number of cents c with c/100 ≥ amount/rate, by cross-
      // multiplication in bigint (no division at all).
      const [ai, af = ''] = amount.split('.');
      const [ri, rf = ''] = rate.split('.');
      const a = BigInt(ai! + af);
      const r = BigInt(ri! + rf);
      const lhs = (c: bigint) => c * r * 10n ** BigInt(af.length); // c/100 × rate, scaled
      const rhs = a * 100n * 10n ** BigInt(rf.length); // amount, scaled alike
      const [ui, uf] = usd.split('.');
      expect(uf, usd).toHaveLength(2);
      const cents = BigInt(ui! + uf!);
      expect(lhs(cents) >= rhs, `${amount} ${currency} @ ${rate} → ${usd}`).toBe(true);
      expect(lhs(cents - 1n) < rhs, `${amount} ${currency} @ ${rate} → ${usd}`).toBe(true);
    }
  });

  it('the conversion code has no float operations', () => {
    const src = readFileSync(new URL('./fx.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/parseFloat|Number\(|Math\.|toPrecision|\*\*\s*-/);
  });

  it('covers every currency in WooCommerce’s default list', () => {
    // get_woocommerce_currencies(), WooCommerce 8.x.
    const woo =
      'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTC BTN BWP BYR BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GGP GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS IMP INR IQD IRR IRT ISK JEP JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PRB PYG QAR RMB RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLL SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VEF VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW';
    const missing = woo.split(' ').filter((c) => ISO_4217_MINOR_UNITS[c] === undefined);
    expect(missing).toEqual([]);
    expect(ISO_4217_MINOR_UNITS).toMatchObject({ JPY: 0, KRW: 0, KWD: 3, BHD: 3, NGN: 2, USD: 2 });
  });
});

describe('getUsdRate', () => {
  let redis: Redis;
  const now = new Date('2026-10-26T12:00:00Z');

  /** A provider stub returning `rate` with the given age. */
  function stub(rate: string, ageMs: number, delayMs = 0) {
    const fn = vi.fn(async (base: string) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      void base;
      return { rate, source: 'stub', asOf: new Date(now.getTime() - ageMs) };
    });
    const provider: FxProvider = { id: 'stub', rate: fn };
    return { provider, fn };
  }

  beforeAll(async () => {
    redis = createRedis(env().REDIS_URL);
    await whenReady(redis);
  });
  beforeEach(async () => {
    await resetFxCache(redis);
  });
  afterAll(async () => {
    await resetFxCache(redis);
    await closeClient(redis);
  });

  it('returns the provider rate with its own timestamp', async () => {
    const { provider } = stub('1602.04', 2 * MIN);
    const r = await getUsdRate('NGN', now, { livemode: true, provider, redis });
    expect(r).toEqual({
      currency: 'NGN',
      rate: '1602.04',
      source: 'stub',
      asOf: new Date(now.getTime() - 2 * MIN),
    });
  });

  it('rate 11 min old → FX_RATE_UNAVAILABLE 503', async () => {
    const { provider } = stub('1602.04', 11 * MIN);
    const err = await rejectionOf(getUsdRate('NGN', now, { livemode: true, provider, redis }));
    expect(err.code).toBe('FX_RATE_UNAVAILABLE');
    expect(err.status).toBe(503);
  });

  it('provider error → FX_RATE_UNAVAILABLE, and the error is not cached', async () => {
    const fn = vi
      .fn<FxProvider['rate']>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ rate: '1602.04', source: 'stub', asOf: now });
    const provider: FxProvider = { id: 'stub', rate: fn };
    const err = await rejectionOf(getUsdRate('NGN', now, { livemode: true, provider, redis }));
    expect(err.code).toBe('FX_RATE_UNAVAILABLE');
    expect(err.status).toBe(503);
    expect((await getUsdRate('NGN', now, { livemode: true, provider, redis })).rate).toBe(
      '1602.04',
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a malformed provider rate is unavailable', async () => {
    for (const rate of ['', '0', '0.00', '-1', 'abc', '1e3']) {
      const { provider } = stub(rate, 0);
      const err = await rejectionOf(getUsdRate('NGN', now, { livemode: true, provider, redis }));
      expect(err.code, rate).toBe('FX_RATE_UNAVAILABLE');
      await resetFxCache(redis);
    }
  });

  it('cache hit within 60 s does not call provider', async () => {
    const { provider, fn } = stub('1602.04', 1 * MIN);
    await getUsdRate('NGN', now, { livemode: true, provider, redis });
    const again = await getUsdRate('NGN', new Date(now.getTime() + 30_000), {
      livemode: true,
      provider,
      redis,
    });
    expect(again.rate).toBe('1602.04');
    expect(again.asOf).toEqual(new Date(now.getTime() - MIN));
    expect(fn).toHaveBeenCalledTimes(1);
    // Cached for 60 s, per currency.
    expect(FX_CACHE_TTL_S).toBe(60);
    const keys = await redis.keys('*fx*stub:NGN');
    expect(keys).toHaveLength(1);
    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(50);
    expect(ttl).toBeLessThanOrEqual(60);
    await getUsdRate('EUR', now, { livemode: true, provider, redis });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never serves a cached rate once it is older than 10 minutes', async () => {
    expect(FX_MAX_AGE_MS).toBe(10 * MIN);
    const { provider, fn } = stub('1602.04', 9.5 * MIN);
    await getUsdRate('NGN', now, { livemode: true, provider, redis });
    // Still cached, but the rate itself has aged past 10 minutes: refused, no fallback.
    const err = await rejectionOf(
      getUsdRate('NGN', new Date(now.getTime() + MIN), { livemode: true, provider, redis }),
    );
    expect(err.code).toBe('FX_RATE_UNAVAILABLE');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('single-flight: concurrent misses call the provider once', async () => {
    const { provider, fn } = stub('1602.04', 0, 50);
    const all = await Promise.all(
      Array.from({ length: 8 }, () => getUsdRate('NGN', now, { livemode: true, provider, redis })),
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((r) => r.rate))).toEqual(new Set(['1602.04']));
  });

  it('with Redis down, fetches at once (no cache, no lock wait)', async () => {
    const dead = createRedis('redis://127.0.0.1:1');
    try {
      const { provider, fn } = stub('1602.04', 0);
      const t0 = Date.now();
      const r = await getUsdRate('NGN', now, { livemode: true, provider, redis: dead });
      expect(r.rate).toBe('1602.04');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      dead.disconnect();
    }
  });

  it('single-flight across processes: a held Redis lock waits for the holder’s rate', async () => {
    const { provider, fn } = stub('9.99', 0);
    // Another process holds the lock and is fetching; it writes the cache shortly.
    await redis.set(fxLockKey('stub', 'NGN'), 'other-process', 'PX', 5000);
    setTimeout(() => {
      void redis.set(
        fxCacheKey('stub', 'NGN'),
        JSON.stringify({ rate: '1602.04', source: 'stub', asOf: now.toISOString() }),
        'EX',
        60,
      );
    }, 150);
    const r = await getUsdRate('NGN', now, { livemode: true, provider, redis });
    expect(r.rate).toBe('1602.04');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('providers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    loadEnv();
  });

  it('test mode always uses the fixed provider, whatever FX_PROVIDER says', () => {
    loadEnv({ ...process.env, FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'k' });
    expect(fxProviderFor(false).id).toBe('fixed');
    expect(fxProviderFor(true).id).toBe('openexchangerates');
    loadEnv({ ...process.env, FX_PROVIDER: 'fixed' });
    expect(fxProviderFor(true).id).toBe('fixed');
  });

  it('the fixed provider reads FX_FIXED_RATES', async () => {
    loadEnv({ ...process.env, FX_FIXED_RATES: '{"NGN":"1602.04"}' });
    const r = await fixedFxProvider().rate('NGN', 'USD');
    expect(r.rate).toBe('1602.04');
    expect(r.source).toBe('fixed');
    await expect(fixedFxProvider().rate('EUR', 'USD')).rejects.toThrow(/EUR/);
    expect(() => loadEnv({ ...process.env, FX_FIXED_RATES: '{"NGN":1602.04}' })).toThrow(
      /FX_FIXED_RATES/,
    );
  });

  describe('openexchangerates', () => {
    const ts = 1_793_016_000; // 2026-10-26T12:00:00Z
    function respond(body: string, status = 200) {
      return vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(body, { status, headers: { 'content-type': 'json' } }));
    }

    it('reads the exact rate text and the provider’s own timestamp', async () => {
      const spy = respond(
        `{"disclaimer":"x","timestamp":${ts},"base":"USD","rates":{"NGN":1602.0400000000001}}`,
      );
      const r = await openExchangeRatesProvider('key-1').rate('NGN', 'USD');
      expect(r).toEqual({
        rate: '1602.0400000000001',
        source: 'openexchangerates',
        asOf: new Date(ts * 1000),
      });
      const url = new URL(String(spy.mock.calls[0]![0]));
      expect(url.origin).toBe('https://openexchangerates.org');
      expect(url.pathname).toBe('/api/latest.json');
      expect(url.searchParams.get('app_id')).toBe('key-1');
      expect(url.searchParams.get('symbols')).toBe('NGN');
    });

    it('expands exponent notation exactly', async () => {
      respond(`{"timestamp":${ts},"base":"USD","rates":{"VND":2.5e4}}`);
      expect((await openExchangeRatesProvider('k').rate('VND', 'USD')).rate).toBe('25000');
    });

    it('a missing timestamp is unavailable', async () => {
      respond(`{"base":"USD","rates":{"NGN":1602.04}}`);
      await expect(openExchangeRatesProvider('k').rate('NGN', 'USD')).rejects.toThrow(/timestamp/);
      respond(`{"timestamp":"soon","base":"USD","rates":{"NGN":1602.04}}`);
      await expect(openExchangeRatesProvider('k').rate('NGN', 'USD')).rejects.toThrow(/timestamp/);
    });

    it('rejects an error status, another base, a missing currency, and bad JSON', async () => {
      const p = openExchangeRatesProvider('k');
      respond('{"error":true,"status":401,"message":"invalid_app_id"}', 401);
      await expect(p.rate('NGN', 'USD')).rejects.toThrow(/401/);
      respond(`{"timestamp":${ts},"base":"EUR","rates":{"NGN":1700}}`);
      await expect(p.rate('NGN', 'USD')).rejects.toThrow(/base/);
      respond(`{"timestamp":${ts},"base":"USD","rates":{}}`);
      await expect(p.rate('NGN', 'USD')).rejects.toThrow(/NGN/);
      respond('not json');
      await expect(p.rate('NGN', 'USD')).rejects.toThrow();
    });

    it('with a missing timestamp, getUsdRate is FX_RATE_UNAVAILABLE', async () => {
      respond(`{"base":"USD","rates":{"NGN":1602.04}}`);
      const redis = createRedis(env().REDIS_URL);
      await whenReady(redis);
      try {
        const err = await rejectionOf(
          getUsdRate('NGN', new Date(), {
            livemode: true,
            provider: openExchangeRatesProvider('k'),
            redis,
          }),
        );
        expect(err.code).toBe('FX_RATE_UNAVAILABLE');
      } finally {
        await resetFxCache(redis);
        await closeClient(redis);
      }
    });
  });
});
