import type { PublicPaymentLinkView } from '@tendr/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchPublicLink = vi.fn();
vi.mock('@/lib/payment-links', () => ({
  fetchPublicLink: (...a: unknown[]) => fetchPublicLink(...a),
  payerIpFrom: () => null,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('react', async (orig) => ({
  ...(await orig<typeof import('react')>()),
  // The server build dedupes per request; the test build doesn't, so memoize by arguments.
  cache: <T extends (...a: never[]) => unknown>(fn: T) => {
    const seen = new Map<string, unknown>();
    return ((...a: never[]) => {
      const k = `${(globalThis as { __req?: number }).__req}:${JSON.stringify(a)}`;
      if (!seen.has(k)) seen.set(k, fn(...a));
      return seen.get(k);
    }) as T;
  },
}));
vi.mock('next/navigation', () => ({ notFound: () => undefined }));

import PaymentLinkPage, { generateMetadata } from './page';
import { tendrShopperTheme } from '@/lib/checkout/brand';

let req = 0;
const base: PublicPaymentLinkView = {
  merchant: { name: 'Acme' },
  theme: tendrShopperTheme('Acme'),
  title: 'T-shirt',
  description: null,
  amount_type: 'fixed',
  amount: '25000.00',
  currency: 'NGN',
  minor_units: 2,
  min_amount: null,
  usd_rate: null,
  note: 'off',
  fee_payer: 'merchant',
  availability: 'available',
  livemode: true,
};
const meta = (view: PublicPaymentLinkView | null, mode?: string) => {
  fetchPublicLink.mockResolvedValue(view);
  (globalThis as { __req?: number }).__req = ++req; // each call is its own request
  return generateMetadata({
    params: Promise.resolve({ id: 'acme', link: 'tee' }),
    searchParams: Promise.resolve(mode ? { mode } : {}),
  });
};

beforeEach(() => {
  // A new "request" per test: React's cache is scoped to one server request.
  (globalThis as { __req?: number }).__req = ++req;
  vi.stubEnv('WEB_URL', 'https://usetendr.tech');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fetchPublicLink.mockReset();
});

describe('generateMetadata', () => {
  it('uses CHECKOUT_BASE_URL (not WEB_URL) for the image URL', async () => {
    vi.stubEnv('CHECKOUT_BASE_URL', 'https://pay.example.com/');
    const m = await meta(base);
    expect(m.openGraph?.images).toEqual([
      { url: 'https://pay.example.com/pay/acme/tee/opengraph-image', width: 1200, height: 630 },
    ]);
  });

  it('one render path reads the link once', async () => {
    fetchPublicLink.mockResolvedValue(base);
    const props = {
      params: Promise.resolve({ id: 'acme', link: 'tee' }),
      searchParams: Promise.resolve({}),
    };
    await generateMetadata(props);
    await PaymentLinkPage(props);
    expect(fetchPublicLink).toHaveBeenCalledTimes(1);
  });

  it('metadata for fixed, open, test and inactive links', async () => {
    const fixed = await meta(base);
    expect(fixed.title).toBe('T-shirt');
    expect(fixed.openGraph?.title).toBe('T-shirt');
    expect(fixed.openGraph?.description).toBe('Acme · ₦25,000');
    expect(fixed.openGraph?.images).toEqual([
      { url: 'https://usetendr.tech/pay/acme/tee/opengraph-image', width: 1200, height: 630 },
    ]);

    const open = await meta({ ...base, amount_type: 'open', amount: null });
    expect(open.openGraph?.description).toBe('Acme · Pay any amount');

    const test = await meta({ ...base, livemode: false }, 'test');
    expect(test.openGraph?.description).toBe('Test · Acme · ₦25,000');
    expect(test.openGraph?.images).toEqual([
      {
        url: 'https://usetendr.tech/pay/acme/tee/opengraph-image?mode=test',
        width: 1200,
        height: 630,
      },
    ]);

    const off = await meta({ ...base, availability: 'inactive' });
    expect(off.openGraph?.description).toBe('Acme');
    expect(off.title).toBe('T-shirt');
  });

  it('handles an unknown link without throwing', async () => {
    const m = await meta(null);
    expect(m.title).toBe('Payment link not found');
    expect(m.openGraph).toBeUndefined();
  });
});
