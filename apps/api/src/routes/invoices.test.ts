import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { env, loadEnv } from '../env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createUser, createRow, resetDb, setLiveMode } from '../test/helpers.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { MemoryMailer, setMailer } from '../auth/mailer.js';
import { HttpOneClick, resetOneClickProviders } from '../checkout/oneclick/index.js';
import { resetTokenCache } from '../checkout/tokens.js';
import { invoiceUnits } from '../invoices/invoices.js';
import { onInvoiceNotice } from '../jobs/invoice-notices.js';

const ASSET = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEST = '0x1111111111111111111111111111111111111111';
const BASE = '/v1/invoices/public/business';
describe('contractor invoice API', () => {
  let app: FastifyInstance;
  let merchantId: string;
  let login: Login;
  let mail: MemoryMailer;
  let ip: string;
  const headers = () => dashHeaders(login, { merchantId, livemode: true });
  const input = () => ({
    contractorName: 'Contractor',
    email: `contractor-${randomBytes(6).toString('hex')}@example.com`,
    reference: 'INV-001',
    description: 'Design work',
    amount: '100.25',
    destinationAsset: ASSET,
    destination: DEST,
    dueDate: '2026-11-30',
  });
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, payload, remoteAddress: ip });
  const secret = () =>
    new URLSearchParams(new URL(mail.sent.at(-1)!.data.url!).hash.slice(1)).get('token')!;
  beforeEach(async () => {
    await resetDb();
    setLiveMode(true);
    resetTokenCache();
    resetOneClickProviders();
    ip = `127.${Math.floor(Math.random() * 250) + 1}.1.1`;
    vi.stubEnv('INVOICE_BASE_URL', 'https://invoice.usetendr.tech');
    loadEnv();
    mail = new MemoryMailer();
    setMailer(mail);
    vi.spyOn(HttpOneClick.prototype, 'tokens').mockResolvedValue([
      { assetId: ASSET, blockchain: 'base', decimals: 6, symbol: 'USDC' },
    ]);
    const user = await createUser({ emailVerifiedAt: new Date() });
    login = await loginAs(user.id);
    merchantId = (await createMerchant({ slug: 'business', invoicesEnabled: true })).id;
    await createRow('MerchantUser', merchantId, false, { userId: user.id, role: 'owner' });
    await createRow('MerchantAccount', merchantId, true, {
      kind: 'native_intents',
      status: 'active',
    });
    await createRow('NativeWallet', merchantId, true, { ownerUserId: user.id });
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    setMailer(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetTokenCache();
    resetOneClickProviders();
    setLiveMode(undefined);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows credential-free invoice requests on the invoice and fallback app origins only', async () => {
    for (const origin of ['https://invoice.usetendr.tech', new URL(env().WEB_URL).origin]) {
      const res = await app.inject({ method: 'GET', url: BASE, headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { origin: 'https://invoice.usetendr.tech' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('verifies email before the inbox, never creates a Tendr user, and returns only token-authorized details', async () => {
    const users = await prisma.user.count();
    const view = await app.inject({ method: 'GET', url: BASE });
    expect(view.statusCode).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(Object.keys(view.json().business)).toEqual(['name', 'slug']);
    const res = await post(BASE, input());
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    const token = secret();
    expect(new URL(mail.sent.at(-1)!.data.url!).origin).toBe(new URL(env().WEB_URL).origin);
    expect(new URL(mail.sent.at(-1)!.data.url!).pathname).toBe('/invoice/business');
    const draft = await prisma.invoice.findFirstOrThrow();
    expect(draft.accessTokenHash).not.toBe(token);
    expect(draft.amount).toBe('100250000');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/invoices', headers: headers() })).json()
        .invoices,
    ).toEqual([]);
    expect((await post(`${BASE}/status`, { token: 'a'.repeat(43) })).statusCode).toBe(401);
    expect((await post('/v1/invoices/public/somebody-else/status', { token })).statusCode).toBe(
      401,
    );
    expect((await post(`${BASE}/verify`, { token })).json()).toMatchObject({
      status: 'open',
      amount: '100250000',
      destination: DEST,
    });
    expect((await post(`${BASE}/verify`, { token })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/invoices', headers: headers() })).json()
        .invoices,
    ).toHaveLength(1);
    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.event.count({ where: { type: 'invoice.submitted' } })).toBe(1);
    expect((await post(`${BASE}/status`, { token })).body).not.toContain('accessTokenHash');
  });

  it('deduplicates retries, rotates verification links, and preserves the original invoice terms', async () => {
    const body = input();
    await post(BASE, body);
    const old = secret();
    await post(BASE, {
      ...body,
      amount: '999',
      destination: '0x2222222222222222222222222222222222222222',
    });
    const fresh = secret();
    expect(fresh).not.toBe(old);
    expect(await prisma.invoice.count()).toBe(1);
    expect((await post(`${BASE}/verify`, { token: old })).statusCode).toBe(401);
    expect((await post(`${BASE}/verify`, { token: fresh })).json()).toMatchObject({
      amount: '100250000',
      destination: DEST,
    });
    await post(BASE, body);
    expect(mail.sent).toHaveLength(2);
  });

  it('rejects expired verification, invalid addresses, excess precision, zero and unsupported assets', async () => {
    for (const patch of [
      { amount: '0' },
      { amount: '1.0000001' },
      { destination: 'not-an-address' },
      { destinationAsset: 'nep141:unknown.near' },
    ]) {
      const res = await post(BASE, { ...input(), ...patch });
      expect(res.statusCode, res.body).toBe(400);
    }
    await post(BASE, input());
    const token = secret();
    await prisma.invoice.updateMany({ data: { verifyExpiresAt: new Date(0) } });
    expect((await post(`${BASE}/verify`, { token })).statusCode).toBe(409);
    expect(() => invoiceUnits('340282366920938463463374607431768211456', 0)).toThrow();
  });

  it('limits email sends per mailbox and leaves no caller-readable token', async () => {
    const body = input();
    for (let i = 0; i < 3; i++)
      expect((await post(BASE, { ...body, reference: `REF-${i}` })).statusCode).toBe(202);
    const blocked = await post(BASE, { ...body, reference: 'REF-4' });
    expect(blocked.statusCode).toBe(429);
    expect(mail.sent).toHaveLength(3);
  });

  it('allows pausing the public page without losing previously verified invoices', async () => {
    await post(BASE, input());
    const token = secret();
    await post(`${BASE}/verify`, { token });
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/invoices/settings',
      payload: { enabled: false },
      headers: headers(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({ method: 'GET', url: BASE })).statusCode).toBe(404);
    expect((await post(BASE, input())).statusCode).toBe(404);
    expect((await post(`${BASE}/status`, { token })).statusCode).toBe(200);
  });

  it('isolates inboxes and modes and requires CSRF and owner authorization for settings', async () => {
    await post(BASE, input());
    const token = secret();
    await post(`${BASE}/verify`, { token });
    const row = await prisma.invoice.findFirstOrThrow();
    const other = await createMerchant();
    await createRow('MerchantUser', other.id, false, { userId: login.userId, role: 'owner' });
    const wrong = dashHeaders(login, { merchantId: other.id, livemode: true });
    expect(
      (await app.inject({ method: 'GET', url: `/v1/invoices/${row.id}`, headers: wrong }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/invoices', headers: wrong })).json().invoices,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/invoices/settings',
          payload: { enabled: false },
          headers: dashHeaders(login, { merchantId, livemode: true, csrf: null }),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('notifies the owner only after verification and deduplicates event retries', async () => {
    await post(BASE, input());
    const token = secret();
    expect(await prisma.event.count({ where: { type: 'invoice.submitted' } })).toBe(0);
    await post(`${BASE}/verify`, { token });
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'invoice.submitted' } });
    await onInvoiceNotice(event);
    await onInvoiceNotice(event);
    expect(mail.sent.filter((m) => m.template === 'invoice_notice')).toHaveLength(1);
    expect(mail.sent.at(-1)!.to).toBe(
      (await prisma.user.findUniqueOrThrow({ where: { id: login.userId } })).email,
    );
    expect(mail.sent.at(-1)!.text).not.toContain(token);
  });
});
