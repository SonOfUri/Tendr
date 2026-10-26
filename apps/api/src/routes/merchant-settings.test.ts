import type { Merchant } from '@prisma/client';
import { CONNECTION_KEY_SCOPES, type MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { setMailer } from '../auth/mailer.js';
import { normalizeCheckoutDomain, validateCheckoutDomains } from '../checkout/checkout-settings.js';
import { revokeConnection } from '../connect/connections.js';
import {
  onNotificationEmailChanged,
  onNotificationEmailRequested,
} from '../jobs/notification-email-notices.js';
import { prisma } from '../lib/prisma.js';
import {
  LINK_SECRET_PURPOSE,
  NOTIFICATION_EMAIL_REQUESTED,
  NOTIFICATION_EMAIL_VERIFIED,
} from '../merchants/notification-email.js';
import { dashHeaders, loginAs, memoryMailer, type Login } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

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
      notification_email: null,
      notification_email_pending: null,
      payment_emails_enabled: true,
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
      notification_email: null,
      notification_email_pending: null,
      payment_emails_enabled: true,
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

describe('store settings from a connection key, and the notification email', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let owner: Login;
  let ownerEmail: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let delivered: Set<string>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    memoryMailer().clear();
    delivered = new Set();
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Bean Shop' });
    const u = await createUser({ emailVerifiedAt: new Date() });
    ownerEmail = u.email;
    await createRow('MerchantUser', merchant.id, false, { userId: u.id, role: 'owner' });
    owner = await loginAs(u.id);
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function connectionKey(livemode = false) {
    const conn = await createRow('Connection', merchant.id, livemode, {});
    const { raw, record } = await createApiKey(merchant.id, {
      livemode,
      scopes: [...CONNECTION_KEY_SCOPES],
    });
    await prisma.apiKey.update({ where: { id: record.id }, data: { connectionId: conn.id } });
    return { raw, connectionId: conn.id };
  }

  const byKey = (method: 'GET' | 'PATCH', raw: string, payload?: unknown) =>
    app.inject({
      method,
      url: '/v1/settings/checkout',
      headers: { authorization: `Bearer ${raw}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const byUser = (method: 'GET' | 'PATCH', who: Login, payload?: unknown) =>
    app.inject({
      method,
      url: '/v1/settings/checkout',
      headers: dashHeaders(who, { merchantId: merchant.id }),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const verify = (token: unknown, a: FastifyInstance = app) =>
    a.inject({
      method: 'POST',
      url: '/v1/settings/notification-email/verify',
      payload: { token },
    });
  const mails = (template: string) => memoryMailer().sent.filter((m) => m.template === template);
  /** Runs the notification-email handlers on the events not handled yet, as the worker would. */
  const deliver = async () => {
    const events = await prisma.event.findMany({
      where: {
        merchantId: merchant.id,
        type: {
          in: [
            NOTIFICATION_EMAIL_REQUESTED,
            NOTIFICATION_EMAIL_VERIFIED,
            'merchant.notification_email.cleared',
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const e of events) {
      if (delivered.has(e.id)) continue;
      if (e.type === NOTIFICATION_EMAIL_REQUESTED) await onNotificationEmailRequested(e);
      else await onNotificationEmailChanged(e);
      delivered.add(e.id);
    }
  };
  /** The raw token of the last verify link sent to `to` (after delivering pending events). */
  const linkToken = async (to: string) => {
    await deliver();
    const m = [...mails('notification_email_verify')].reverse().find((x) => x.to === to);
    if (!m) throw new Error(`no verify mail to ${to}`);
    const url = new URL(m.data.url!);
    expect(url.pathname).toBe('/settings/notification-email/verify');
    return url.searchParams.get('t')!;
  };

  it('connection key can PATCH fee/gas payer and notification_email but not checkout_domains', async () => {
    const { raw, connectionId } = await connectionKey();
    const read = await byKey('GET', raw);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      default_fee_payer: 'merchant',
      notification_email: null,
      notification_email_pending: null,
      payment_emails_enabled: true,
    });

    const res = await byKey('PATCH', raw, {
      default_fee_payer: 'shopper',
      default_gas_payer: 'merchant',
      notification_email: 'Orders@Shop.example',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      default_fee_payer: 'shopper',
      default_gas_payer: 'merchant',
      notification_email: null,
      notification_email_pending: 'orders@shop.example',
    });

    for (const body of [
      { checkout_domains: ['https://shop.example'] },
      { payment_emails_enabled: false },
      { default_fee_payer: 'merchant', checkout_domains: [] },
    ]) {
      const denied = await byKey('PATCH', raw, body);
      expect(denied.statusCode, JSON.stringify(body)).toBe(403);
      expect(denied.json().error.code).toBe('FIELD_NOT_ALLOWED');
    }
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row).toMatchObject({
      checkoutDomains: [],
      paymentEmailsEnabled: true,
      defaultFeePayer: 'payer',
    });

    // Audit: who changed it, from which connection.
    const events = await prisma.event.findMany({
      where: { merchantId: merchant.id, type: 'merchant.checkout_settings.updated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ actor: { by: 'connection', connectionId } });

    // A secret key the store made by hand is not a connection key.
    const plain = await createApiKey(merchant.id, { livemode: false });
    expect((await byKey('GET', plain.raw)).statusCode).toBe(403);
    expect((await byKey('PATCH', plain.raw, { default_fee_payer: 'merchant' })).statusCode).toBe(
      403,
    );
  });

  it('a dashboard user sets payment_emails_enabled; changes are logged as by the user', async () => {
    const res = await byUser('PATCH', owner, { payment_emails_enabled: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().payment_emails_enabled).toBe(false);
    const e = await prisma.event.findFirstOrThrow({
      where: { merchantId: merchant.id, type: 'merchant.checkout_settings.updated' },
    });
    expect(e.payload).toMatchObject({ actor: { by: 'user', userId: owner.userId } });
  });

  it('notification_email not effective until verified; old address notified on change', async () => {
    const { raw } = await connectionKey();
    await byKey('PATCH', raw, { notification_email: 'first@shop.example' });
    await deliver();
    expect(mails('notification_email_verify').map((m) => m.to)).toEqual(['first@shop.example']);
    const link = mails('notification_email_verify')[0]!.data.url!;
    expect(link).toMatch(/\/settings\/notification-email\/verify\?t=[A-Za-z0-9_-]{43}$/);
    // Nothing goes to the unverified address and nothing changed yet.
    expect((await byKey('GET', raw)).json().notification_email).toBeNull();

    const ok = await verify(await linkToken('first@shop.example'));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ notification_email: 'first@shop.example' });
    expect((await byKey('GET', raw)).json()).toMatchObject({
      notification_email: 'first@shop.example',
      notification_email_pending: null,
    });
    await deliver();
    // No previous address: the owners are told.
    expect(mails('notification_email_changed').map((m) => m.to)).toEqual([ownerEmail]);

    await byKey('PATCH', raw, { notification_email: 'second@shop.example' });
    expect((await verify(await linkToken('second@shop.example'))).statusCode).toBe(200);
    await deliver();
    const changed = mails('notification_email_changed');
    expect(changed.map((m) => m.to)).toEqual([ownerEmail, 'first@shop.example']);
    expect(changed[1]!.data.new_email).toBe('second@shop.example');
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.notificationEmail).toBe('second@shop.example');
    // The verify is in the audit log too.
    const events = await prisma.event.findMany({
      where: { merchantId: merchant.id, type: 'merchant.notification_email.verified' },
    });
    expect(events).toHaveLength(2);
  });

  it('a dashboard-set email still needs verification', async () => {
    const res = await byUser('PATCH', owner, { notification_email: 'boss@shop.example' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      notification_email: null,
      notification_email_pending: 'boss@shop.example',
    });
    expect((await verify(await linkToken('boss@shop.example'))).statusCode).toBe(200);
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.notificationEmail).toBe('boss@shop.example');
    // Setting it back to null (owners) needs no link.
    const cleared = await byUser('PATCH', owner, { notification_email: null });
    expect(cleared.json().notification_email).toBeNull();
  });

  it('expired or reused verify token rejected', async () => {
    const { raw } = await connectionKey();
    await byKey('PATCH', raw, { notification_email: 'a@shop.example' });
    const token = await linkToken('a@shop.example');
    expect((await verify(token)).statusCode).toBe(200);
    const reused = await verify(token);
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.code).toBe('INVALID_LINK');

    await byKey('PATCH', raw, { notification_email: 'b@shop.example' });
    const late = await linkToken('b@shop.example');
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { notificationEmailTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    expect((await verify(late)).json().error.code).toBe('INVALID_LINK');
    for (const bad of ['', 'x', 42, 'A'.repeat(43)]) {
      expect((await verify(bad)).statusCode, String(bad)).toBe(400);
    }
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.notificationEmail).toBe('a@shop.example');
  });

  it('a new request invalidates the old token', async () => {
    const { raw } = await connectionKey();
    await byKey('PATCH', raw, { notification_email: 'old-link@shop.example' });
    const first = await linkToken('old-link@shop.example');
    await byKey('PATCH', raw, { notification_email: 'new-link@shop.example' });
    expect((await verify(first)).json().error.code).toBe('INVALID_LINK');
    expect((await verify(await linkToken('new-link@shop.example'))).statusCode).toBe(200);
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row.notificationEmail).toBe('new-link@shop.example');
    // Every encrypted token is gone once its request ended or its link went out.
    expect(await prisma.secret.count({ where: { purpose: LINK_SECRET_PURPOSE } })).toBe(0);
  });

  it('a request notifies the current address at once (or the owners), masked', async () => {
    const { raw } = await connectionKey();
    // No current address: the owners are warned.
    await byKey('PATCH', raw, { notification_email: 'attacker@evil.example' });
    await deliver();
    const first = mails('notification_email_change_requested');
    expect(first.map((m) => m.to)).toEqual([ownerEmail]);
    expect(first[0]!.text).toContain(
      'A change of notification email to a***@evil.example was requested from the connected site https://shop.example.com.',
    );
    expect(first[0]!.text).toContain("If this wasn't you, disconnect the site or contact support.");
    expect(first[0]!.text).not.toContain('attacker@');

    // With a verified address, that address is warned — even if the change is verified before
    // the warning is sent (recipients are pinned when the change is asked for).
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { notificationEmail: 'current@shop.example' },
    });
    await byUser('PATCH', owner, { notification_email: 'next@shop.example' });
    await deliver();
    const second = mails('notification_email_change_requested');
    expect(second.map((m) => m.to)).toEqual([ownerEmail, 'current@shop.example']);
    expect(second[1]!.text).toContain('requested from the tendr dashboard');
  });

  it('revoking the connection clears its pending change', async () => {
    const { raw, connectionId } = await connectionKey();
    await byKey('PATCH', raw, { notification_email: 'site@shop.example' });
    const token = await linkToken('site@shop.example');
    await prisma.$transaction((tx) => revokeConnection(tx, connectionId, 'site'));
    const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(row).toMatchObject({
      notificationEmailPending: null,
      notificationEmailTokenHash: null,
      notificationEmailLinkSecretRef: null,
    });
    expect((await verify(token)).json().error.code).toBe('INVALID_LINK');
    expect(
      await prisma.event.count({
        where: { merchantId: merchant.id, type: 'merchant.notification_email.request_cancelled' },
      }),
    ).toBe(1);

    // Undelivered link: revoke before the mail goes out → the link is never sent, token deleted.
    const other = await connectionKey();
    await byKey('PATCH', other.raw, { notification_email: 'late@shop.example' });
    await byUser('PATCH', owner, { notification_email: 'mine@shop.example' });
    await prisma.$transaction((tx) => revokeConnection(tx, other.connectionId, 'dashboard'));
    // The dashboard's own request stays pending.
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } }))
        .notificationEmailPending,
    ).toBe('mine@shop.example');
    await deliver();
    expect(mails('notification_email_verify').map((m) => m.to)).not.toContain('late@shop.example');
  });

  it('a mail failure still commits the settings change; the verify mail is sent once after commit', async () => {
    const { raw } = await connectionKey();
    const mem = memoryMailer();
    setMailer({
      send: async () => {
        throw new Error('smtp down');
      },
    });
    try {
      const res = await byKey('PATCH', raw, {
        default_fee_payer: 'shopper',
        notification_email: 'later@shop.example',
      });
      expect(res.statusCode, res.body).toBe(200);
      // Nothing was mailed inside the request.
      expect(mem.sent).toHaveLength(0);
      const row = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
      expect(row).toMatchObject({
        defaultFeePayer: 'payer',
        notificationEmailPending: 'later@shop.example',
      });
      await expect(deliver()).rejects.toThrow(/smtp down/);
    } finally {
      setMailer(mem);
    }
    // The retry sends the link once, however often the job runs.
    await deliver();
    const e = await prisma.event.findFirstOrThrow({
      where: { merchantId: merchant.id, type: NOTIFICATION_EMAIL_REQUESTED },
    });
    await onNotificationEmailRequested(e);
    await onNotificationEmailRequested(e);
    expect(mails('notification_email_verify').map((m) => m.to)).toEqual(['later@shop.example']);
    expect(mails('notification_email_change_requested').map((m) => m.to)).toEqual([ownerEmail]);
    expect((await verify(await linkToken('later@shop.example'))).statusCode).toBe(200);
  });

  it('never stores the raw token in events or plaintext columns', async () => {
    const { raw } = await connectionKey();
    await byKey('PATCH', raw, { notification_email: 'secret@shop.example' });
    const token = await linkToken('secret@shop.example');
    await verify(token);
    await deliver();
    const events = await prisma.$queryRaw<{ payload: string }[]>`
      SELECT payload::text AS payload FROM events WHERE merchant_id = ${merchant.id}`;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.payload).not.toContain(token);
    const m = await prisma.$queryRaw<{ row: string }[]>`
      SELECT row_to_json(merchants)::text AS row FROM merchants WHERE id = ${merchant.id}`;
    expect(m[0]!.row).not.toContain(token);
  });

  it('strips line breaks from the store name in subjects', async () => {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { name: 'Bean\r\nBcc: x@evil.example' },
    });
    await byUser('PATCH', owner, { notification_email: 'boss@shop.example' });
    await deliver();
    for (const m of memoryMailer().sent) expect(m.subject).not.toMatch(/[\r\n]/);
    expect(mails('notification_email_verify')[0]!.subject).toBe(
      'Confirm the email for Bean Bcc: x@evil.example on tendr',
    );
  });

  it('logs handler-level denials as the gateway does', async () => {
    const lines = () =>
      logSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l: string) => l.includes('"msg":"request"'));
    const { raw } = await connectionKey();
    logSpy.mockClear();
    await byKey('PATCH', raw, { checkout_domains: [] });
    const denied = lines();
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0]!)).toMatchObject({
      outcome: 'forbidden',
      statusCode: 403,
      principal: 'secret_key',
    });
  });

  it('verify is rate-limited per IP', async () => {
    const limited = await buildApp({ rateLimitOverrides: { notification_email_verify: 2 } });
    await limited.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await verify('A'.repeat(43), limited)).statusCode);
      expect(codes).toEqual([400, 400, 429]);
    } finally {
      await limited.close();
    }
  });
});
