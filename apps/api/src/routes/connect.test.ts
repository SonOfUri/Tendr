import { createHash, randomBytes } from 'node:crypto';
import type { Merchant } from '@prisma/client';
import { ConnectTokenResponseSchema, type MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { setWebhookResolver } from '../checkout/webhooks.js';
import { sweepConnections } from '../connect/authorize.js';
import { flushLastUsed } from '../gateway/auth.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import {
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
} from '../test/helpers.js';

const SITE = 'https://shop.example.com';
const RETURN = `${SITE}/wp-json/tendr/v1/connect/return`;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('connect routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let admin: Login;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant({ name: 'Acme' });
    admin = await member(merchant.id, 'admin');
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(async () => {
    await flushLastUsed();
    await app.close();
    setWebhookResolver(null);
    logSpy.mockRestore();
    vi.useRealTimers();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(
    merchantId: string,
    role: MerchantUserRole,
    opts: { stepUp?: boolean; isSigner?: boolean } = {},
  ) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchantId, false, {
      userId: user.id,
      role,
      isSigner: opts.isSigner ?? false,
    });
    return loginAs(user.id, opts);
  }

  const authorizeBody = (challenge: string, over: Record<string, unknown> = {}) => ({
    site_url: SITE,
    return_url: RETURN,
    state: 'st-123',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    platform: 'woocommerce',
    plugin_version: '1.0.0',
    ...over,
  });

  const authorize = (who: Login, payload: unknown, merchantId = merchant.id) =>
    app.inject({
      method: 'POST',
      url: '/v1/connect/authorize',
      headers: dashHeaders(who, { merchantId }),
      payload: payload as object,
    });

  const token = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/connect/token', payload: payload as object });

  /** Approves a connection and returns the code from the redirect plus the PKCE verifier. */
  async function approve(who = admin, merchantId = merchant.id) {
    const { verifier, challenge } = pkce();
    const res = await authorize(who, authorizeBody(challenge), merchantId);
    expect(res.statusCode).toBe(200);
    const redirect = new URL(res.json().redirect as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(RETURN);
    expect(redirect.searchParams.get('state')).toBe('st-123');
    const code = redirect.searchParams.get('code')!;
    return { code, verifier };
  }

  /** A full connect: approve, then redeem. Returns the token response. */
  async function connect(who = admin, merchantId = merchant.id) {
    const { code, verifier } = await approve(who, merchantId);
    const res = await token({ code, code_verifier: verifier, site_url: SITE });
    expect(res.statusCode).toBe(200);
    return ConnectTokenResponseSchema.parse(res.json());
  }

  const status = (key: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/connect/status',
      headers: { authorization: `Bearer ${key}` },
    });

  const expectInvalidGrant = (res: Awaited<ReturnType<typeof token>>) => {
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'INVALID_GRANT',
      message: 'The authorization code is invalid or expired',
    });
    expect(res.json().error.details).toBeUndefined();
  };

  // ─── authorize ──────────────────────────────────────────────────────────────

  it('authorize requires owner/admin and step-up', async () => {
    const { challenge } = pkce();
    for (const role of ['viewer', 'finance'] as const) {
      const res = await authorize(await member(merchant.id, role), authorizeBody(challenge));
      expect(res.statusCode).toBe(403);
    }
    const noStepUp = await member(merchant.id, 'admin', { stepUp: false });
    const res = await authorize(noStepUp, authorizeBody(challenge));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(await prisma.connection.count()).toBe(0);

    const owner = await member(merchant.id, 'owner');
    expect((await authorize(owner, authorizeBody(challenge))).statusCode).toBe(200);
    expect((await authorize(admin, authorizeBody(challenge))).statusCode).toBe(200);
  });

  it('authorize rejects return_url on a different origin', async () => {
    const { challenge } = pkce();
    for (const return_url of [
      'https://evil.example.com/wp-json/tendr/v1/connect/return',
      'http://shop.example.com/wp-json/tendr/v1/connect/return',
      'https://shop.example.com:8443/return',
      `${RETURN}#frag`,
      'javascript:alert(1)',
      'https://user:pw@shop.example.com/return',
    ]) {
      const res = await authorize(admin, authorizeBody(challenge, { return_url }));
      expect(res.statusCode, return_url).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.connection.count()).toBe(0);
  });

  it('authorize rejects a challenge that is not S256', async () => {
    const res = await authorize(admin, authorizeBody('short', { code_challenge_method: 'plain' }));
    expect(res.statusCode).toBe(400);
    expect(await prisma.connection.count()).toBe(0);
  });

  it('authorize stores only digests and encrypted credentials; nothing is readable before /token', async () => {
    const { code } = await approve();
    const row = await prisma.connectAuthCode.findFirstOrThrow();
    expect(row.codeHash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(row.credentialsRef).not.toBeNull();
    expect(Buffer.from(code, 'base64url').length).toBeGreaterThanOrEqual(32);
    const connection = await prisma.connection.findFirstOrThrow();
    expect(connection.redeemedAt).toBeNull();
    // The un-redeemed connection is not listed (and so its keys are nowhere to be seen).
    const list = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: dashHeaders(admin, { merchantId: merchant.id }),
    });
    expect(list.json().connections).toEqual([]);
    const dump = JSON.stringify(await prisma.secret.findMany());
    expect(dump).not.toContain('tdr_test_');
    expect(dump).not.toContain('tdr_live_');
  });

  // ─── token ──────────────────────────────────────────────────────────────────

  it('token succeeds once; second use → INVALID_GRANT', async () => {
    const { code, verifier } = await approve();
    const res = await token({ code, code_verifier: verifier, site_url: SITE });
    expect(res.statusCode).toBe(200);
    const body = ConnectTokenResponseSchema.parse(res.json());
    expect(body.store).toMatchObject({ id: merchant.id, name: 'Acme', live_account: null });
    expect(body.test.secret_key).toMatch(/^tdr_test_/);
    expect(body.live.secret_key).toMatch(/^tdr_live_/);
    expect(body.test.webhook_secret).toMatch(/^whsec_/);
    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: body.connection_id },
    });
    expect(connection.redeemedAt).not.toBeNull();
    // The stored credentials are gone once handed out.
    const codeRow = await prisma.connectAuthCode.findFirstOrThrow();
    expect(codeRow.usedAt).not.toBeNull();
    expect(codeRow.credentialsRef).toBeNull();
    expect(await prisma.secret.count({ where: { purpose: 'connect_credentials' } })).toBe(0);

    expectInvalidGrant(await token({ code, code_verifier: verifier, site_url: SITE }));
  });

  it('token: concurrent double redemption → exactly one success', async () => {
    const { code, verifier } = await approve();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => token({ code, code_verifier: verifier, site_url: SITE })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 400, 400, 400]);
    for (const r of results.filter((x) => x.statusCode === 400)) expectInvalidGrant(r);
  });

  it('token with wrong verifier → INVALID_GRANT', async () => {
    const { code } = await approve();
    expectInvalidGrant(await token({ code, code_verifier: pkce().verifier, site_url: SITE }));
  });

  it('token after 60 s → INVALID_GRANT', async () => {
    const { code, verifier } = await approve();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expectInvalidGrant(await token({ code, code_verifier: verifier, site_url: SITE }));
  });

  it('token with mismatched site_url → INVALID_GRANT', async () => {
    const { code, verifier } = await approve();
    expectInvalidGrant(
      await token({ code, code_verifier: verifier, site_url: 'https://other.example.com' }),
    );
  });

  it('token: an unknown code and malformed bodies are the same INVALID_GRANT', async () => {
    const { verifier } = pkce();
    expectInvalidGrant(
      await token({
        code: randomBytes(32).toString('base64url'),
        code_verifier: verifier,
        site_url: SITE,
      }),
    );
    expectInvalidGrant(await token({ code: 'x' }));
    expectInvalidGrant(
      await token({ code: 'x', code_verifier: 'short', site_url: SITE, extra: 1 }),
    );
  });

  it('token is rate-limited to 10 per minute per IP', async () => {
    const { verifier } = pkce();
    const body = { code: 'nope', code_verifier: verifier, site_url: SITE };
    for (let i = 0; i < 10; i += 1) expect((await token(body)).statusCode).toBe(400);
    expect((await token(body)).statusCode).toBe(429);
  });

  // ─── status ─────────────────────────────────────────────────────────────────

  async function signerWithPasskeys(n: number) {
    const user = await createUser();
    await createRow('MerchantUser', merchant.id, false, {
      userId: user.id,
      role: 'owner',
      isSigner: true,
    });
    for (let i = 0; i < n; i += 1) await createCredential(user.id);
    return user;
  }

  it('status lists live_account_missing before go-live and single_key nudge with one passkey', async () => {
    await signerWithPasskeys(1);
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    const creds = await connect();
    const res = await status(creds.live.secret_key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connection_id: creds.connection_id,
      mode: 'live',
      ready: false,
      blocking: [
        {
          code: 'live_account_missing',
          message: 'Finish going live on your tendr dashboard',
          href: 'http://localhost:3000/dashboard',
        },
      ],
      nudges: [
        {
          code: 'single_key',
          message: "Add a second device or a co-owner so a lost phone can't lock you out",
          href: 'http://localhost:3000/dashboard/onboarding/second-key',
        },
      ],
    });
  });

  it('status: a live account still provisioning, then no payout method', async () => {
    await signerWithPasskeys(2);
    const creds = await connect();
    const live = await createRow('MerchantAccount', merchant.id, true, { status: 'provisioning' });
    let body = (await status(creds.live.secret_key)).json();
    expect(body.ready).toBe(false);
    expect(body.blocking.map((b: { code: string }) => b.code)).toEqual(['live_account_pending']);
    expect(body.blocking[0].message).toBe('Your live account is still being set up');
    // Two passkeys: no nudge (the recovery kit does not matter either way).
    expect(body.nudges).toEqual([]);

    await prisma.merchantAccount.update({ where: { id: live.id }, data: { status: 'active' } });
    body = (await status(creds.live.secret_key)).json();
    expect(body.blocking).toEqual([
      {
        code: 'payout_missing',
        message: 'Add a payout method',
        href: 'http://localhost:3000/dashboard/settings/payout',
      },
    ]);
  });

  it('status ready after go-live + payout', async () => {
    await signerWithPasskeys(1);
    const creds = await connect();
    await createRow('MerchantAccount', merchant.id, true, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, true, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const body = (await status(creds.live.secret_key)).json();
    expect(body).toMatchObject({ mode: 'live', ready: true, blocking: [] });
    // The nudge never blocks.
    expect(body.nudges.map((n: { code: string }) => n.code)).toEqual(['single_key']);
  });

  it('status in test mode is ready once the test account is active and payout is set', async () => {
    await signerWithPasskeys(2);
    const creds = await connect();
    const acct = await createRow('MerchantAccount', merchant.id, false, { status: 'provisioning' });
    await createRow('SettlementConfig', merchant.id, false, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    let body = (await status(creds.test.secret_key)).json();
    expect(body).toMatchObject({ mode: 'test', ready: false });
    expect(body.blocking.map((b: { code: string }) => b.code)).toEqual(['test_account_pending']);
    await prisma.merchantAccount.update({ where: { id: acct.id }, data: { status: 'active' } });
    body = (await status(creds.test.secret_key)).json();
    // No go-live items in test mode, even though the store has no live account.
    expect(body).toEqual({
      connection_id: creds.connection_id,
      mode: 'test',
      ready: true,
      blocking: [],
      nudges: [],
    });
  });

  it('status refuses a secret key with no connection (403) and a publishable key', async () => {
    const plain = await createApiKey(merchant.id, { livemode: true });
    const res = await status(plain.raw);
    expect(res.statusCode).toBe(403);
    const creds = await connect();
    expect((await status(creds.live.publishable_key)).statusCode).toBe(403);
  });

  // ─── disconnect ─────────────────────────────────────────────────────────────

  it('disconnect → old key 401', async () => {
    const creds = await connect();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connect/disconnect',
      headers: { authorization: `Bearer ${creds.test.secret_key}` },
    });
    expect(res.statusCode).toBe(204);
    expect((await status(creds.test.secret_key)).statusCode).toBe(401);
    expect((await status(creds.live.secret_key)).statusCode).toBe(401);
    const c = await prisma.connection.findUniqueOrThrow({ where: { id: creds.connection_id } });
    expect(c.revokedAt).not.toBeNull();
    // A Disconnect from the site keeps the domain.
    const m = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(m.checkoutDomains).toContain(SITE);
  });

  it('disconnect refuses a secret key with no connection', async () => {
    const plain = await createApiKey(merchant.id, { livemode: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connect/disconnect',
      headers: { authorization: `Bearer ${plain.raw}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── dashboard: connected sites ─────────────────────────────────────────────

  it('lists the store’s connected sites with who connected them and when they were last used', async () => {
    const creds = await connect();
    await status(creds.test.secret_key);
    await flushLastUsed();
    const other = await createMerchant();
    const otherAdmin = await member(other.id, 'admin');
    await connect(otherAdmin, other.id);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: dashHeaders(admin, { merchantId: merchant.id }),
    });
    expect(res.statusCode).toBe(200);
    const { connections } = res.json();
    expect(connections).toHaveLength(1);
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(connections[0]).toMatchObject({
      id: creds.connection_id,
      site_url: SITE,
      platform: 'woocommerce',
      connected_by: { user_id: admin.userId, email: adminUser.email },
      status: 'active',
    });
    expect(connections[0].created_at).toEqual(expect.any(String));
    expect(connections[0].last_used_at).toEqual(expect.any(String));
    expect(JSON.stringify(connections)).not.toContain('tdr_');

    // A viewer cannot see it.
    const viewer = await member(merchant.id, 'viewer');
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: dashHeaders(viewer, { merchantId: merchant.id }),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('DELETE /v1/connections/:id removes the site and its domain (step-up)', async () => {
    const creds = await connect();
    const del = (who: Login) =>
      app.inject({
        method: 'DELETE',
        url: `/v1/connections/${creds.connection_id}`,
        headers: dashHeaders(who, { merchantId: merchant.id }),
      });
    const noStepUp = await member(merchant.id, 'admin', { stepUp: false });
    expect((await del(noStepUp)).statusCode).toBe(401);
    expect((await del(await member(merchant.id, 'finance'))).statusCode).toBe(403);

    const res = await del(admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: creds.connection_id, deleted: true });
    expect((await status(creds.live.secret_key)).statusCode).toBe(401);
    const m = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(m.checkoutDomains).not.toContain(SITE);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/connections',
      headers: dashHeaders(admin, { merchantId: merchant.id }),
    });
    expect(list.json().connections[0]).toMatchObject({ status: 'revoked' });
  });

  it('DELETE /v1/connections/:id from another store → 404', async () => {
    const creds = await connect();
    const other = await createMerchant();
    const otherAdmin = await member(other.id, 'admin');
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/connections/${creds.connection_id}`,
      headers: dashHeaders(otherAdmin, { merchantId: other.id }),
    });
    expect(res.statusCode).toBe(404);
    const c = await prisma.connection.findUniqueOrThrow({ where: { id: creds.connection_id } });
    expect(c.revokedAt).toBeNull();
    expect((await status(creds.test.secret_key)).statusCode).toBe(200);
  });

  // ─── sessions ───────────────────────────────────────────────────────────────

  it('session created with a connection key stores connectionId', async () => {
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const creds = await connect();
    const create = (key: string, ref: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/checkout/sessions',
        headers: { authorization: `Bearer ${key}` },
        payload: {
          amount: '10.00',
          amount_currency: 'USD',
          external_ref: ref,
          success_url: `${SITE}/thanks`,
          cancel_url: `${SITE}/cart`,
        },
      });
    const res = await create(creds.test.secret_key, 'order-1');
    expect(res.statusCode).toBe(201);
    const session = await prisma.session.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(session.connectionId).toBe(creds.connection_id);

    const plain = await createApiKey(merchant.id, { livemode: false });
    const res2 = await create(plain.raw, 'order-2');
    expect(res2.statusCode).toBe(201);
    const s2 = await prisma.session.findUniqueOrThrow({ where: { id: res2.json().id } });
    expect(s2.connectionId).toBeNull();
  });

  // ─── un-redeemed sweeper ────────────────────────────────────────────────────

  it('sweeps connections never redeemed after 10 minutes, removing the domain they added', async () => {
    const pending = await approve();
    const redeemed = await connect(admin);
    // A second site whose domain the store added by hand.
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { checkoutDomains: { push: 'https://hand.example.com' } },
    });
    const { challenge } = pkce();
    const handRes = await authorize(
      admin,
      authorizeBody(challenge, {
        site_url: 'https://hand.example.com',
        return_url: 'https://hand.example.com/return',
      }),
    );
    expect(handRes.statusCode).toBe(200);

    // Nothing is old enough yet.
    expect(await sweepConnections()).toBe(0);
    // After the code's 60 s, the stored credentials are deleted though the connection waits.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    await sweepConnections();
    expect(await prisma.secret.count({ where: { purpose: 'connect_credentials' } })).toBe(0);
    expect(await prisma.connection.count({ where: { revokedAt: { not: null } } })).toBe(0);

    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await sweepConnections()).toBe(2);
    const rows = await prisma.connection.findMany({ orderBy: { createdAt: 'asc' } });
    const byOrigin = new Map(rows.map((r) => [r.siteOrigin, r]));
    expect(rows.find((r) => r.id === redeemed.connection_id)!.revokedAt).toBeNull();
    expect(rows.filter((r) => r.revokedAt !== null)).toHaveLength(2);
    expect(byOrigin.get('https://hand.example.com')!.revokedAt).not.toBeNull();
    const m = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    // The redeemed connection still uses SITE, so it keeps the domain; the hand-added one stays.
    expect(m.checkoutDomains).toEqual(expect.arrayContaining([SITE, 'https://hand.example.com']));
    // The swept code can no longer be redeemed.
    expectInvalidGrant(
      await token({ code: pending.code, code_verifier: pending.verifier, site_url: SITE }),
    );
    expect(await sweepConnections()).toBe(0);
  });

  it('the sweeper removes a domain an un-redeemed connection added when no one else uses it', async () => {
    await approve();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 });
    expect(await sweepConnections()).toBe(1);
    const m = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } });
    expect(m.checkoutDomains).not.toContain(SITE);
    const keys = await prisma.apiKey.findMany();
    expect(keys.every((k) => k.revokedAt !== null)).toBe(true);
  });
});
