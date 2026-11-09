import { describe, expect, it } from 'vitest';
import { defaultAuth, endpoints, exampleBody, needsStore } from './catalog';
import { invoicePayoutStep } from './invoice-flow';

const payout = {
  id: 'npay_123',
  invoiceId: 'bill_123',
  status: 'awaiting_signature',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};
describe('invoice console flow', () => {
  it('keeps contractor endpoints public and merchant endpoints session scoped', () => {
    const invoices = endpoints.filter((e) => e.path.startsWith('/v1/invoices'));
    expect(invoices).toHaveLength(10);
    for (const endpoint of invoices) {
      const publicRoute = endpoint.path.includes('/public/');
      expect(defaultAuth(endpoint)).toBe(publicRoute ? 'public' : 'session');
      expect(needsStore(endpoint)).toBe(!publicRoute);
      if (!publicRoute && endpoint.method !== 'GET') expect(endpoint.stepUp).toBe(true);
    }
    const create = invoices.find((e) => e.id === 'POST /v1/invoices/public/:business')!;
    expect(JSON.parse(exampleBody(create))).toMatchObject({
      items: [
        { description: 'Contractor services', amount: '0.75' },
        { description: 'Expenses', amount: '0.25' },
      ],
      reference: 'CONSOLE-INV-001',
    });
    const pay = invoices.find((e) => e.id === 'POST /v1/invoices/:id/payout')!;
    expect(Object.keys(JSON.parse(exampleBody(pay)))).toEqual(['asset']);
  });
  it('only prepares a challenge for the same invoice and an unexpired unsigned payout', () => {
    expect(invoicePayoutStep('/v1/invoices/bill_123/payout', payout)).toEqual({
      payoutId: 'npay_123',
    });
    for (const patch of [
      { invoiceId: 'bill_other' },
      { id: 'npay_123/submit' },
      { expiresAt: 'invalid' },
      { expiresAt: new Date(0).toISOString() },
      { status: 'submitted' },
      { status: 'completed' },
    ])
      expect(invoicePayoutStep('/v1/invoices/bill_123/payout', { ...payout, ...patch })).toBeNull();
    expect(invoicePayoutStep('/v1/account/native/payouts', payout)).toBeNull();
    expect(invoicePayoutStep('/v1/invoices/%invalid/payout', payout)).toBeNull();
  });
});
