import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/payment-links', async () => ({
  fetchPublicLink: async () => ({
    merchant: { name: 'Acme' },
    theme: (await import('@/lib/checkout/brand')).tendrShopperTheme('Acme'),
    title: 'T-shirt',
    amount_type: 'open',
    amount: null,
    currency: 'USD',
    minor_units: 2,
    availability: 'available',
  }),
  payerIpFrom: () => null,
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { GET } from './route';

describe('opengraph-image route', () => {
  it('serves a cacheable PNG', async () => {
    const res = await GET(new Request('http://localhost/pay/acme/tee/opengraph-image'), {
      params: Promise.resolve({ id: 'acme', link: 'tee' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });
});
