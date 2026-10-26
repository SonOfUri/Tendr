import type { Merchant } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { normalizeCheckoutDomain, validateCheckoutDomains } from '../checkout/checkout-settings.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

describe('checkout domain validation', () => {
  const ok = (raw: string, production = true) => normalizeCheckoutDomain(raw, production);

  it('accepts https origins and normalises them', () => {
    expect(ok('https://Shop.Example')).toEqual({ origin: 'https://shop.example' });
    expect(ok('https://shop.example/')).toEqual({ origin: 'https://shop.example' });
    expect(ok('https://shop.example:443')).toEqual({ origin: 'https://shop.example' });
    expect(ok('https://shop.example:8443')).toEqual({ origin: 'https://shop.example:8443' });
  });

  it('refuses paths, queries, fragments, credentials, wildcards and non-URLs', () => {
    for (const bad of [
      'https://shop.example/checkout',
      'https://shop.example/x/..',
      'https://shop.example?a=1',
      'https://shop.example#x',
      'https://user:pw@shop.example',
      'https://*.shop.example',
      'shop.example',
      'ftp://shop.example',
      'javascript:alert(1)',
    ]) {
      expect(ok(bad, false), bad).toHaveProperty('error');
    }
  });

  it('http only for localhost, and only outside production', () => {
    expect(ok('http://localhost:3000', false)).toEqual({ origin: 'http://localhost:3000' });
    expect(ok('http://127.0.0.1:8080', false)).toEqual({ origin: 'http://127.0.0.1:8080' });
    expect(ok('http://localhost:3000', true)).toHaveProperty('error');
    expect(ok('http://shop.example', false)).toHaveProperty('error');
  });

  it('deduplicates after normalising, then caps at 20', () => {
    expect(
      validateCheckoutDomains(
        ['https://a.example', 'https://A.example/', 'https://b.example'],
        true,
      ),
    ).toEqual(['https://a.example', 'https://b.example']);
    const twenty = Array.from({ length: 20 }, (_, i) => `https://s${i}.example`);
    expect(validateCheckoutDomains([...twenty, twenty[0]!], true)).toHaveLength(20);
    expect(() => validateCheckoutDomains([...twenty, 'https://s20.example'], true)).toThrow(
      /At most 20/,
    );
  });
});

describe('checkout settings routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let admin: Login;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ defaultFeePayer: 'merchant', defaultGasPayer: 'buyer' });
    admin = await member('admin');
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(role: MerchantUserRole, opts: { stepUp?: boolean; m?: Merchant } = {}) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', (opts.m ?? merchant).id, false, { userId: user.id, role });
    return loginAs(user.id, opts);
  }

  const call = (
    method: 'GET' | 'PATCH',
    who: Login,
    payload?: unknown,
    opts: { livemode?: boolean; merchantId?: string } = {},
  ) =>
    app.inject({
      method,
      url: '/v1/settings/checkout',
      headers: dashHeaders(who, {
        merchantId: opts.merchantId ?? merchant.id,
        livemode: opts.livemode ?? false,
      }),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('reads and updates the settings (API payer names), shared by both modes', async () => {
    const before = await call('GET', admin);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({
      checkout_domains: [],
      default_fee_payer: 'merchant',
      default_gas_payer: 'shopper',
    });
    const res = await call('PATCH', admin, {
      checkout_domains: ['https://Shop.example/', 'https://shop.example', 'http://localhost:3000'],
      default_fee_payer: 'shopper',
      default_gas_payer: 'merchant',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      checkout_domains: ['https://shop.example', 'http://localhost:3000'],
      default_fee_payer: 'shopper',
      default_gas_payer: 'merchant',
    });
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row).toMatchObject({ defaultFeePayer: 'payer', defaultGasPayer: 'merchant' });
    // Live reads the same merchant-wide settings.
    expect((await call('GET', admin, undefined, { livemode: true })).json()).toEqual(res.json());
    // A partial update leaves the rest alone, and every change is in the event log.
    const partial = await call('PATCH', admin, { default_gas_payer: 'shopper' });
    expect(partial.json().checkout_domains).toEqual([
      'https://shop.example',
      'http://localhost:3000',
    ]);
    const events = await prisma.event.findMany({
      where: { merchantId: merchant.id, type: 'merchant.checkout_settings.updated' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ user_id: admin.userId });
  });

  it('rejects invalid domains with 400 and changes nothing', async () => {
    for (const checkout_domains of [
      ['https://shop.example/pay'],
      ['http://shop.example'],
      Array.from({ length: 21 }, (_, i) => `https://s${i}.example`),
    ]) {
      const res = await call('PATCH', admin, { checkout_domains });
      expect(res.statusCode, JSON.stringify(checkout_domains)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await call('PATCH', admin, { default_fee_payer: 'payer' })).statusCode).toBe(400);
    expect((await call('PATCH', admin, { unknown: 1 })).statusCode).toBe(400);
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.checkoutDomains).toEqual([]);
  });

  it('needs settings:manage; changes need step-up and CSRF', async () => {
    for (const role of ['finance', 'viewer'] as const) {
      const who = await member(role);
      expect((await call('GET', who)).statusCode).toBe(403);
      expect((await call('PATCH', who, { default_fee_payer: 'shopper' })).statusCode).toBe(403);
    }
    const noStepUp = await member('admin', { stepUp: false });
    expect((await call('GET', noStepUp)).statusCode).toBe(200);
    const res = await call('PATCH', noStepUp, { default_fee_payer: 'shopper' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/v1/settings/checkout',
      headers: dashHeaders(admin, { merchantId: merchant.id, csrf: null }),
      payload: { default_fee_payer: 'shopper' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("is confined to the caller's store", async () => {
    const other = await createMerchant({ checkoutDomains: ['https://other.example'] });
    // A member of this store only cannot read or change the other store.
    expect((await call('GET', admin, undefined, { merchantId: other.id })).statusCode).toBe(403);
    expect(
      (await call('PATCH', admin, { checkout_domains: [] }, { merchantId: other.id })).statusCode,
    ).toBe(403);
    await call('PATCH', admin, { checkout_domains: ['https://mine.example'] });
    const o = await prisma.merchant.findUniqueOrThrow({ where: { id: other.id } });
    expect(o.checkoutDomains).toEqual(['https://other.example']);
  });
});
