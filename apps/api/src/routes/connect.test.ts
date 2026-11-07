import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type Event, type Merchant } from '@prisma/client';
import { ConnectTokenResponseSchema, type MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import {
  attemptDelivery,
  deliveryKey,
  fanOutEvent,
  listDeliveries,
  resendDelivery,
  SEND_LEASE_MS,
  setBeforeFanOutWriteHook,
  setWebhookResolver,
  setBeforeSendHook,
  setWebhookTransport,
  sweepDueDeliveries,
  type WebhookRequest,
} from '../checkout/webhooks.js';
import { sweepConnections } from '../connect/authorize.js';
import { flushLastUsed } from '../gateway/auth.js';
import { verifyRequestSignature } from '../gateway/signing.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import {
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
  setLiveMode,
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
    // These tests cover live connections as they behave once live mode is open; the switch-off
    // behaviour has its own tests below.
    setLiveMode(true);
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
    setWebhookTransport(null);
    setBeforeSendHook(null);
    setBeforeFanOutWriteHook(null);
    logSpy.mockRestore();
    vi.useRealTimers();
    setLiveMode(undefined);
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

  it('switch off: live status blocks first on live_mode_unavailable; test status is unaffected', async () => {
    setLiveMode(undefined);
    await signerWithPasskeys(1);
    await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, false, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const creds = await connect();
    const res = await status(creds.live.secret_key);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ mode: 'live', ready: false });
    expect(body.blocking).toEqual([
      {
        code: 'live_mode_unavailable',
        message: 'Live payments are not open yet. Test mode works as usual.',
        href: 'http://localhost:3000/dashboard',
      },
      {
        code: 'live_account_missing',
        message: 'Finish going live on your tendr dashboard',
        href: 'http://localhost:3000/dashboard',
      },
    ]);
    // Even with an active live account and payout, live stays blocked while the switch is off.
    await createRow('MerchantAccount', merchant.id, true, { status: 'active' });
    await createRow('SettlementConfig', merchant.id, true, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });
    const after = (await status(creds.live.secret_key)).json();
    expect(after.ready).toBe(false);
    expect(after.blocking.map((b: { code: string }) => b.code)).toEqual(['live_mode_unavailable']);

    const test = (await status(creds.test.secret_key)).json();
    expect(test).toMatchObject({ mode: 'test', ready: true, blocking: [] });
  });

  it('switch off: a live connection key cannot create a session (403) but still reads status', async () => {
    setLiveMode(undefined);
    const creds = await connect();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${creds.live.secret_key}` },
      payload: {
        amount: '10.00',
        amount_currency: 'USD',
        external_ref: 'order-live',
        success_url: `${SITE}/thanks`,
        cancel_url: `${SITE}/cart`,
      },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('LIVE_MODE_UNAVAILABLE');
    expect(await prisma.session.count({ where: { livemode: true } })).toBe(0);
    expect((await status(creds.live.secret_key)).statusCode).toBe(200);
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

  it('connects a ready native live wallet independently of failed test provisioning', async () => {
    await createRow('MerchantAccount', merchant.id, false, { status: 'failed' });
    const live = await createRow('MerchantAccount', merchant.id, true, {
      kind: 'native_intents',
      status: 'active',
      nearAccountId: `0x${'ab'.repeat(32)}`,
    });
    await createRow('SettlementConfig', merchant.id, true, {
      payoutMode: 'intents',
      payoutAddress: null,
      isDefault: true,
    });

    // Authorization and PKCE redemption do not require a working test account.
    const creds = await connect();
    expect(creds.store.live_account).toBe(live.nearAccountId);
    expect((await status(creds.live.secret_key)).json()).toMatchObject({
      mode: 'live',
      ready: true,
      blocking: [],
    });
    expect((await status(creds.test.secret_key)).json()).toMatchObject({
      mode: 'test',
      ready: false,
      blocking: [{ code: 'test_account_pending' }],
    });

    // Connecting still cannot override the platform's live switch.
    setLiveMode(undefined);
    expect((await status(creds.live.secret_key)).json()).toMatchObject({
      mode: 'live',
      ready: false,
      blocking: [{ code: 'live_mode_unavailable' }],
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

  it('sweeps connections never redeemed after 10 minutes; a domain they did not add stays', async () => {
    const redeemed = await connect(admin);
    // A later approval for the same site, never redeemed (the working connection keeps going).
    const pending = await approve();
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

  // ─── fix round 1 ────────────────────────────────────────────────────────────

  it('authorize refuses a missing CSRF token and a store the person is not a member of', async () => {
    const { challenge } = pkce();
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/v1/connect/authorize',
      headers: dashHeaders(admin, { merchantId: merchant.id, csrf: null }),
      payload: authorizeBody(challenge),
    });
    expect(noCsrf.statusCode).toBe(403);
    const other = await createMerchant();
    await member(other.id, 'owner');
    const cross = await authorize(admin, authorizeBody(challenge), other.id);
    expect(cross.statusCode).toBe(403);
    expect(await prisma.connection.count()).toBe(0);
  });

  it('token: transport-level failures are the same INVALID_GRANT', async () => {
    const raw = (payload: string, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/v1/connect/token', payload, headers });
    expectInvalidGrant(await raw('{"code":', { 'content-type': 'application/json' }));
    expectInvalidGrant(
      await raw('code=x', { 'content-type': 'application/x-www-form-urlencoded' }),
    );
    expectInvalidGrant(await raw('{"code":"x"}', { 'content-type': 'text/plain' }));
    expectInvalidGrant(await raw('{"code":"x"}', {}));
    expectInvalidGrant(
      await raw(JSON.stringify({ code: 'x'.repeat(20_000) }), {
        'content-type': 'application/json',
      }),
    );
    expectInvalidGrant(await raw('', { 'content-type': 'application/json' }));
  });

  it('C8: token maps a Prisma unique/missing-row error to INVALID_GRANT, never a 500', async () => {
    const { code, verifier } = await approve();
    const original = prisma.$transaction.bind(prisma);
    const db = prisma as unknown as { $transaction: unknown };
    try {
      for (const prismaCode of ['P2002', 'P2025']) {
        db.$transaction = () =>
          Promise.reject(
            new Prisma.PrismaClientKnownRequestError('boom', {
              code: prismaCode,
              clientVersion: 'test',
            }),
          );
        expectInvalidGrant(await token({ code, code_verifier: verifier, site_url: SITE }));
      }
    } finally {
      db.$transaction = original;
    }
  });

  it('token: a rate-limited call stays 429 RATE_LIMITED', async () => {
    const body = { code: 'nope', code_verifier: pkce().verifier, site_url: SITE };
    for (let i = 0; i < 10; i += 1) await token(body);
    const res = await token(body);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  async function endpointsOf(connectionId: string) {
    return prisma.webhookEndpoint.findMany({ where: { connectionId } });
  }

  it('re-connect: the old keys get 401 and its endpoints go inactive; the new ones work; the domain moves', async () => {
    const first = await connect();
    // Another subdirectory site on the same origin is a different site and stays.
    const { challenge, verifier } = pkce();
    const sub = await authorize(
      admin,
      authorizeBody(challenge, { site_url: `${SITE}/blog`, return_url: `${SITE}/blog/return` }),
    );
    const subCode = new URL(sub.json().redirect as string).searchParams.get('code')!;
    const subRes = await token({
      code: subCode,
      code_verifier: verifier,
      site_url: `${SITE}/blog`,
    });
    expect(subRes.statusCode).toBe(200);
    const blog = ConnectTokenResponseSchema.parse(subRes.json());

    expect(
      (await prisma.connection.findUniqueOrThrow({ where: { id: first.connection_id } }))
        .addedDomain,
    ).toBe(SITE);
    const second = await connect();

    for (const key of [first.test.secret_key, first.live.secret_key]) {
      expect((await status(key)).statusCode).toBe(401);
    }
    expect((await endpointsOf(first.connection_id)).every((e) => !e.active)).toBe(true);
    expect((await status(second.test.secret_key)).statusCode).toBe(200);
    expect((await status(second.live.secret_key)).statusCode).toBe(200);
    expect((await endpointsOf(second.connection_id)).every((e) => e.active)).toBe(true);
    expect((await status(blog.test.secret_key)).statusCode).toBe(200);

    const oldC = await prisma.connection.findUniqueOrThrow({ where: { id: first.connection_id } });
    const newC = await prisma.connection.findUniqueOrThrow({ where: { id: second.connection_id } });
    expect(oldC.revokedAt).not.toBeNull();
    expect(oldC.addedDomain).toBeNull();
    expect(newC.addedDomain).toBe(SITE);
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).checkoutDomains,
    ).toContain(SITE);
  });

  /** A test-mode payment whose session was created with `connectionId`'s keys. */
  async function paymentOn(connectionId: string) {
    const p = await createRow('Payment', merchant.id, false);
    await prisma.session.update({ where: { id: p.sessionId as string }, data: { connectionId } });
    return p.id as string;
  }

  async function succeededFor(paymentId: string) {
    return (await createRow('Event', merchant.id, false, {
      type: 'payment.succeeded',
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: { payment_id: paymentId },
    })) as unknown as Event;
  }

  const recipients = async (eventId: string) =>
    (await prisma.webhookDelivery.findMany({ where: { eventId } })).map((d) => d.endpointId);

  it('W8: a session created before a re-connect delivers payment.succeeded to the NEW endpoint, not the old one', async () => {
    const first = await connect();
    const paymentId = await paymentOn(first.connection_id);
    const second = await connect();
    expect(
      (await prisma.connection.findUniqueOrThrow({ where: { id: first.connection_id } }))
        .replacedById,
    ).toBe(second.connection_id);
    const ev = await succeededFor(paymentId);
    expect(await fanOutEvent(ev)).toBe(1);
    const [newTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: second.connection_id, livemode: false },
    });
    expect(await recipients(ev.id)).toEqual([newTest!.id]);
  });

  it('W9: an event pending for the old endpoint at re-connect is delivered to the new endpoint exactly once', async () => {
    const sent: WebhookRequest[] = [];
    let up = false; // the old site is down until it re-connects
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: up ? 200 : 503 };
    });
    const first = await connect();
    const [oldTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: first.connection_id, livemode: false },
    });
    const paymentId = await paymentOn(first.connection_id);
    const ev = await succeededFor(paymentId);
    await fanOutEvent(ev);
    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: ev.id } });
    expect((await attemptDelivery(row.id))?.status).toBe('pending'); // failed once, retrying

    up = true;
    sent.length = 0;
    const second = await connect();
    const [newTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: second.connection_id, livemode: false },
    });
    const moved = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(moved).toMatchObject({
      endpointId: newTest!.id,
      eventId: ev.id,
      idempotencyKey: deliveryKey(newTest!.id, ev.id),
      status: 'pending',
      attempt: 0,
    });
    expect(moved.firstAttemptAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(moved.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await prisma.webhookDelivery.count({ where: { endpointId: oldTest!.id } })).toBe(0);

    // Due now: the sweep queues it; sending it (and any replay) reaches the new endpoint once.
    expect(await sweepDueDeliveries()).toBeGreaterThanOrEqual(1);
    for (const d of await prisma.webhookDelivery.findMany({ where: { status: 'pending' } })) {
      await attemptDelivery(d.id);
    }
    await attemptDelivery(row.id);
    await fanOutEvent(ev); // a replayed outbox fan-out adds nothing
    const forEv = sent.filter((r) => r.headers['tendr-event-id'] === ev.id);
    expect(forEv).toHaveLength(1);
    expect(forEv[0]!.url).toBe(newTest!.url);
    const header = forEv[0]!.headers['tendr-signature']!;
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(
      verifyRequestSignature(header, Buffer.from(forEv[0]!.body), second.test.webhook_secret, t),
    ).toBe('ok');
    expect(JSON.parse(forEv[0]!.body)).toMatchObject({ id: ev.id, type: 'payment.succeeded' });
    expect(await prisma.webhookDelivery.count({ where: { eventId: ev.id } })).toBe(1);
  });

  it('W9: an old row whose event the new endpoint already has is marked superseded, never sent twice', async () => {
    const sent: WebhookRequest[] = [];
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
    const first = await connect();
    const paymentId = await paymentOn(first.connection_id);
    const ev = await succeededFor(paymentId);
    await fanOutEvent(ev);
    const old = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: ev.id } });
    // Approve the re-connect, then (before it is redeemed) give its endpoint a row for the event.
    const { code, verifier } = await approve();
    const pendingConn = await prisma.connection.findFirstOrThrow({
      where: { redeemedAt: null, revokedAt: null },
    });
    const [newTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: pendingConn.id, livemode: false },
    });
    await prisma.webhookDelivery.create({
      data: {
        id: `whd_pre_${ev.id}`,
        merchantId: merchant.id,
        livemode: false,
        endpointId: newTest!.id,
        eventId: ev.id,
        eventType: ev.type,
        idempotencyKey: deliveryKey(newTest!.id, ev.id),
        nextRetryAt: new Date(),
      },
    });
    expect((await token({ code, code_verifier: verifier, site_url: SITE })).statusCode).toBe(200);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject(
      { endpointId: old.endpointId, status: 'superseded', nextRetryAt: null },
    );
    expect(await attemptDelivery(old.id)).toBeNull(); // not due, never sent
    for (const d of await prisma.webhookDelivery.findMany({ where: { status: 'pending' } })) {
      await attemptDelivery(d.id);
    }
    expect(sent.filter((r) => r.headers['tendr-event-id'] === ev.id)).toHaveLength(1);
  });

  /** A site connected, with one pending delivery of a payment.succeeded on its test endpoint. */
  async function pendingOnFirstSite() {
    const first = await connect();
    const [oldTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: first.connection_id, livemode: false },
    });
    const ev = await succeededFor(await paymentOn(first.connection_id));
    await fanOutEvent(ev);
    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: ev.id } });
    return { first, oldTest: oldTest!, ev, row };
  }

  const newTestEndpoint = async (connectionId: string) =>
    (await prisma.webhookEndpoint.findMany({ where: { connectionId, livemode: false } }))[0]!;

  /** Sends every due pending delivery (the worker's sweep, run to completion). */
  async function drain() {
    for (const d of await prisma.webhookDelivery.findMany({ where: { status: 'pending' } })) {
      await attemptDelivery(d.id);
    }
  }

  it('W10: claimed by a worker, re-connect, then the send succeeds: one delivery overall, the row ends delivered', async () => {
    const { oldTest, ev, row } = await pendingOnFirstSite();
    const sent: WebhookRequest[] = [];
    let second: Awaited<ReturnType<typeof connect>> | null = null;
    setWebhookTransport(async (req) => {
      sent.push(req);
      // The POST is on the wire to the old site when the site re-connects.
      if (!second) second = await connect();
      return { status: 200 };
    });
    const r = await attemptDelivery(row.id);
    expect(r?.status).toBe('delivered');
    const newTest = await newTestEndpoint(second!.connection_id);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(
      { endpointId: newTest.id, status: 'delivered', nextRetryAt: null },
    );
    await sweepDueDeliveries();
    await drain();
    const forEv = sent.filter((x) => x.headers['tendr-event-id'] === ev.id);
    expect(forEv).toHaveLength(1);
    expect(forEv[0]!.url).toBe(oldTest.url);
  });

  it('W10: claimed by a worker, re-connect, then the send is refused before the POST: delivered once, to the new endpoint', async () => {
    const { ev, row } = await pendingOnFirstSite();
    const sent: WebhookRequest[] = [];
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
    // The worker has claimed the row; the re-connect lands before its send reads the endpoint.
    let second: Awaited<ReturnType<typeof connect>> | null = null;
    setBeforeSendHook(async () => {
      setBeforeSendHook(null);
      second = await connect();
    });
    const r = await attemptDelivery(row.id);
    expect(r?.status).toBe('pending');
    expect(sent).toHaveLength(0); // refused: the old endpoint is inactive
    const newTest = await newTestEndpoint(second!.connection_id);
    const moved = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(moved).toMatchObject({ endpointId: newTest.id, status: 'pending', attempt: 0 });
    expect(moved.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    await drain();
    await drain();
    const forEv = sent.filter((x) => x.headers['tendr-event-id'] === ev.id);
    expect(forEv).toHaveLength(1);
    expect(forEv[0]!.url).toBe(newTest.url);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'delivered',
    );
  });

  it('W10: a moved row near its 3-day deadline gets a fresh window', async () => {
    const { row } = await pendingOnFirstSite();
    const nearDeadline = new Date(Date.now() - 3 * 24 * 3600_000 + 60_000);
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        attempt: 11,
        firstAttemptAt: nearDeadline,
        lastAttemptAt: new Date(Date.now() - 3600_000),
        nextRetryAt: new Date(Date.now() + 3600_000),
      },
    });
    const before = Date.now();
    await connect();
    const moved = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(moved.attempt).toBe(0);
    expect(moved.firstAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(moved.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // A failure now (past the old deadline) retries instead of giving up.
    setWebhookTransport(async () => ({ status: 503 }));
    const r = await attemptDelivery(row.id, { now: new Date(Date.now() + 2 * 60_000) });
    expect(r).toMatchObject({ status: 'pending', attempt: 1 });
  });

  it('W10: a failed (given-up) row moves, stays failed, and can be resent from the dashboard', async () => {
    const { ev, row } = await pendingOnFirstSite();
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: { status: 'failed', nextRetryAt: null, lastError: 'HTTP 503', attempt: 12 },
    });
    const second = await connect();
    const newTest = await newTestEndpoint(second.connection_id);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject(
      { endpointId: newTest.id, status: 'failed', idempotencyKey: deliveryKey(newTest.id, ev.id) },
    );
    const sent: WebhookRequest[] = [];
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
    const ctx = { merchantId: merchant.id, livemode: false };
    expect((await listDeliveries(ctx, newTest.id)).map((d) => d.id)).toContain(row.id);
    expect((await resendDelivery(ctx, row.id)).status).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(newTest.url);
  });

  // ─── C9: re-pointing races ──────────────────────────────────────────────────

  it('C9: superseded while its send was in flight and the send succeeded → the new endpoint’s row is marked delivered, never sent again', async () => {
    const sent: WebhookRequest[] = [];
    const { ev, row } = await pendingOnFirstSite();
    // The re-connect's endpoint already has a row for the event (an earlier fan-out).
    const { code, verifier } = await approve();
    const pendingConn = await prisma.connection.findFirstOrThrow({
      where: { redeemedAt: null, revokedAt: null },
    });
    const newTest = await newTestEndpoint(pendingConn.id);
    const preId = `whd_pre_${ev.id}`;
    await prisma.webhookDelivery.create({
      data: {
        id: preId,
        merchantId: merchant.id,
        livemode: false,
        endpointId: newTest.id,
        eventId: ev.id,
        eventType: ev.type,
        idempotencyKey: deliveryKey(newTest.id, ev.id),
        nextRetryAt: new Date(),
      },
    });
    let redeemed = false;
    setWebhookTransport(async (req) => {
      sent.push(req);
      // The POST to the old site is on the wire when the site re-connects.
      if (!redeemed) {
        redeemed = true;
        expect((await token({ code, code_verifier: verifier, site_url: SITE })).statusCode).toBe(
          200,
        );
      }
      return { status: 200 };
    });
    await attemptDelivery(row.id);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      'superseded',
    );
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: preId } })).toMatchObject({
      status: 'delivered',
      nextRetryAt: null,
    });
    await sweepDueDeliveries();
    await drain();
    expect(sent.filter((x) => x.headers['tendr-event-id'] === ev.id)).toHaveLength(1);
  });

  it('C9: a manual resend is refused while another manual send of the row holds its lease', async () => {
    const { row } = await pendingOnFirstSite();
    const now = new Date();
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: 'delivered',
        lastAttemptAt: now,
        nextRetryAt: new Date(now.getTime() + SEND_LEASE_MS),
      },
    });
    const sent: WebhookRequest[] = [];
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
    const ctx = { merchantId: merchant.id, livemode: false };
    await expect(resendDelivery(ctx, row.id)).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(0);
  });

  it('C9: a fan-out that read the old endpoint before a re-connect and writes after it lands on the new endpoint', async () => {
    const sent: WebhookRequest[] = [];
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
    const first = await connect();
    const ev = await succeededFor(await paymentOn(first.connection_id));
    let second: Awaited<ReturnType<typeof connect>> | null = null;
    setBeforeFanOutWriteHook(async () => {
      setBeforeFanOutWriteHook(null);
      second = await connect();
    });
    expect(await fanOutEvent(ev)).toBe(1);
    const newTest = await newTestEndpoint(second!.connection_id);
    const rows = await prisma.webhookDelivery.findMany({ where: { eventId: ev.id } });
    expect(rows.map((r) => r.endpointId)).toEqual([newTest.id]);
    await drain();
    expect(sent.filter((x) => x.headers['tendr-event-id'] === ev.id)).toHaveLength(1);
  });

  it('W8: two re-connects in a row (A→B→C) deliver to C', async () => {
    const a = await connect();
    const paymentId = await paymentOn(a.connection_id);
    const b = await connect();
    const c = await connect();
    expect(
      (await prisma.connection.findUniqueOrThrow({ where: { id: b.connection_id } })).replacedById,
    ).toBe(c.connection_id);
    const ev = await succeededFor(paymentId);
    await fanOutEvent(ev);
    const [cTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: c.connection_id, livemode: false },
    });
    expect(await recipients(ev.id)).toEqual([cTest!.id]);
  });

  it('W8: after a disconnect (no successor), no bound endpoint receives the event; other sites stay isolated', async () => {
    const shop = await connect();
    const paymentId = await paymentOn(shop.connection_id);
    // Another site of the same store, connected separately: never gets the shop's events.
    const { challenge, verifier } = pkce();
    const sub = await authorize(
      admin,
      authorizeBody(challenge, { site_url: `${SITE}/blog`, return_url: `${SITE}/blog/return` }),
    );
    const subCode = new URL(sub.json().redirect as string).searchParams.get('code')!;
    const blog = ConnectTokenResponseSchema.parse(
      (await token({ code: subCode, code_verifier: verifier, site_url: `${SITE}/blog` })).json(),
    );
    const before = await succeededFor(paymentId);
    await fanOutEvent(before);
    const [shopTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: shop.connection_id, livemode: false },
    });
    expect(await recipients(before.id)).toEqual([shopTest!.id]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/connect/disconnect',
      headers: { authorization: `Bearer ${shop.test.secret_key}` },
    });
    expect(res.statusCode).toBe(204);
    expect(
      (await prisma.connection.findUniqueOrThrow({ where: { id: shop.connection_id } }))
        .replacedById,
    ).toBeNull();
    const after = await succeededFor(paymentId);
    expect(await fanOutEvent(after)).toBe(0);
    const blogEndpoints = await prisma.webhookEndpoint.findMany({
      where: { connectionId: blog.connection_id },
    });
    expect(blogEndpoints.every((e) => e.active)).toBe(true);
  });

  it('re-connect: an abandoned second approval leaves the working connection alone', async () => {
    const first = await connect();
    await approve(); // never redeemed
    expect((await status(first.test.secret_key)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 });
    expect(await sweepConnections()).toBe(1);
    vi.useRealTimers();
    expect((await status(first.test.secret_key)).statusCode).toBe(200);
    const c = await prisma.connection.findUniqueOrThrow({ where: { id: first.connection_id } });
    expect(c).toMatchObject({ revokedAt: null, addedDomain: SITE });
    expect(
      (await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).checkoutDomains,
    ).toContain(SITE);
  });

  it('re-connect to a different store leaves the first store’s connection alone', async () => {
    const first = await connect();
    const other = await createMerchant();
    const otherAdmin = await member(other.id, 'admin');
    const second = await connect(otherAdmin, other.id);
    expect((await status(first.test.secret_key)).statusCode).toBe(200);
    expect((await status(second.test.secret_key)).statusCode).toBe(200);
  });

  it('redeem racing the sweeper: exactly one wins, consistently', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { code, verifier } = await approve();
      const pending = await prisma.connection.findFirstOrThrow({
        where: { redeemedAt: null, revokedAt: null },
      });
      // Old enough for the sweeper while the code is still valid.
      await prisma.connection.update({
        where: { id: pending.id },
        data: { createdAt: new Date(Date.now() - 11 * 60_000) },
      });
      const [res, swept] = await Promise.all([
        token({ code, code_verifier: verifier, site_url: SITE }),
        sweepConnections(),
      ]);
      const c = await prisma.connection.findUniqueOrThrow({ where: { id: pending.id } });
      if (res.statusCode === 200) {
        expect(swept).toBe(0);
        expect(c).toMatchObject({ revokedAt: null });
        expect(c.redeemedAt).not.toBeNull();
        expect((await status(res.json().test.secret_key)).statusCode).toBe(200);
        // Disconnect so the next round's connection is the only pending one.
        await app.inject({
          method: 'POST',
          url: '/v1/connect/disconnect',
          headers: { authorization: `Bearer ${res.json().test.secret_key}` },
        });
      } else {
        expectInvalidGrant(res);
        expect(swept).toBe(1);
        expect(c.revokedAt).not.toBeNull();
        expect(c.redeemedAt).toBeNull();
      }
      expect(await prisma.secret.count({ where: { purpose: 'connect_credentials' } })).toBe(0);
    }
  });

  it('redeem racing a dashboard removal: no deadlock, and the connection ends revoked', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { code, verifier } = await approve();
      const pending = await prisma.connection.findFirstOrThrow({
        where: { redeemedAt: null, revokedAt: null },
      });
      const [res, del] = await Promise.all([
        token({ code, code_verifier: verifier, site_url: SITE }),
        app.inject({
          method: 'DELETE',
          url: `/v1/connections/${pending.id}`,
          headers: dashHeaders(admin, { merchantId: merchant.id }),
        }),
      ]);
      expect(del.statusCode).toBe(200);
      const c = await prisma.connection.findUniqueOrThrow({ where: { id: pending.id } });
      expect(c.revokedAt).not.toBeNull();
      if (res.statusCode === 200) {
        expect((await status(res.json().test.secret_key)).statusCode).toBe(401);
      } else {
        expectInvalidGrant(res);
      }
      expect(await prisma.secret.count({ where: { purpose: 'connect_credentials' } })).toBe(0);
    }
  });

  // ─── replace after a site address change (A3) ───────────────────────────────

  const NEW_SITE = 'https://new-shop.example.com';

  /** A full connect of another site address of the same store. */
  async function connectAt(site: string, who = admin, merchantId = merchant.id) {
    const { verifier, challenge } = pkce();
    const res = await authorize(
      who,
      authorizeBody(challenge, {
        site_url: site,
        return_url: `${site}/wp-json/tendr/v1/connect/return`,
      }),
      merchantId,
    );
    expect(res.statusCode).toBe(200);
    const code = new URL(res.json().redirect as string).searchParams.get('code')!;
    const red = await token({ code, code_verifier: verifier, site_url: site });
    expect(red.statusCode).toBe(200);
    return ConnectTokenResponseSchema.parse(red.json());
  }

  const replace = (key: string, successor: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/connect/replace',
      headers: { authorization: `Bearer ${key}` },
      payload: { successor_connection_id: successor },
    });

  const refundWith = (key: string, paymentId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/refunds',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        payment: paymentId,
        amount: '1.00',
        currency: 'USD',
        reason: 'test',
        external_ref: `wc_refund_${paymentId}`,
      },
    });

  it('A3: re-connect at a new address, replace with the old key → old events reach the new site, the new site may refund old payments, the old key is 401', async () => {
    const a = await connect();
    const paymentId = await paymentOn(a.connection_id);
    const b = await connectAt(NEW_SITE);
    // Before the replace: a different site, so nothing of A's reaches B.
    expect((await status(a.test.secret_key)).statusCode).toBe(200);
    expect((await refundWith(b.test.secret_key, paymentId)).statusCode).toBe(404);

    const res = await replace(a.live.secret_key, b.connection_id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connection_id: a.connection_id, replaced_by: b.connection_id });

    for (const key of [a.test.secret_key, a.live.secret_key]) {
      expect((await status(key)).statusCode).toBe(401);
    }
    const oldC = await prisma.connection.findUniqueOrThrow({ where: { id: a.connection_id } });
    expect(oldC.revokedAt).not.toBeNull();
    expect(oldC.replacedById).toBe(b.connection_id);
    expect((await endpointsOf(a.connection_id)).every((e) => !e.active)).toBe(true);
    expect((await status(b.test.secret_key)).statusCode).toBe(200);

    const ev = await succeededFor(paymentId);
    expect(await fanOutEvent(ev)).toBe(1);
    const [bTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: b.connection_id, livemode: false },
    });
    expect(await recipients(ev.id)).toEqual([bTest!.id]);

    // The payment is still in flight, so it is not refundable — but it is B's now (not 404).
    const r = await refundWith(b.test.secret_key, paymentId);
    expect(r.statusCode).not.toBe(404);
    expect(r.json().error.code).toBe('PAYMENT_NOT_REFUNDABLE');

    const audit = await prisma.event.findMany({
      where: { aggregateId: a.connection_id, type: 'connection.replaced' },
    });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.payload).toMatchObject({
      connection_id: a.connection_id,
      replaced_by: b.connection_id,
    });
  });

  it('A3: replace re-points the old site’s undelivered webhooks to the new site and keeps its sessions open', async () => {
    setWebhookTransport(async () => ({ status: 503 }));
    const a = await connect();
    const paymentId = await paymentOn(a.connection_id);
    const open = (await createRow('Session', merchant.id, false, { connectionId: a.connection_id }))
      .id as string;
    const ev = await succeededFor(paymentId);
    await fanOutEvent(ev);
    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { eventId: ev.id } });
    const b = await connectAt(NEW_SITE);
    expect((await replace(a.test.secret_key, b.connection_id)).statusCode).toBe(200);
    const [bTest] = await prisma.webhookEndpoint.findMany({
      where: { connectionId: b.connection_id, livemode: false },
    });
    const moved = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(moved.endpointId).toBe(bTest!.id);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: open } })).status).toBe(
      'PENDING_DEPOSIT',
    );
  });

  it('A3: replace refuses a bad successor and leaves the old connection working', async () => {
    const a = await connect();
    const other = await createMerchant({ name: 'Other' });
    const otherAdmin = await member(other.id, 'admin');
    const foreign = await connectAt(NEW_SITE, otherAdmin, other.id);

    expect((await replace(a.test.secret_key, 'con_unknown')).statusCode).toBe(404);
    expect((await replace(a.test.secret_key, foreign.connection_id)).statusCode).toBe(404);
    expect((await replace(a.test.secret_key, a.connection_id)).statusCode).toBe(409);
    expect((await replace(a.test.secret_key, '')).statusCode).toBe(400);

    // A successor older than the connection it replaces is refused.
    const older = await connectAt('https://older.example.com');
    await prisma.connection.update({
      where: { id: older.connection_id },
      data: { createdAt: new Date(Date.now() - 3_600_000) },
    });
    expect((await replace(a.test.secret_key, older.connection_id)).statusCode).toBe(409);

    // A revoked successor is refused.
    const gone = await connectAt('https://gone.example.com');
    await app.inject({
      method: 'POST',
      url: '/v1/connect/disconnect',
      headers: { authorization: `Bearer ${gone.test.secret_key}` },
    });
    expect((await replace(a.test.secret_key, gone.connection_id)).statusCode).toBe(409);

    // An un-redeemed successor is refused.
    await approve();
    const pending = await prisma.connection.findFirstOrThrow({
      where: { merchantId: merchant.id, redeemedAt: null, revokedAt: null },
    });
    expect((await replace(a.test.secret_key, pending.id)).statusCode).toBe(409);

    // A hand-made key has no connection to replace.
    const plain = await createApiKey(merchant.id, { livemode: false });
    expect((await replace(plain.raw, a.connection_id)).statusCode).toBe(403);

    expect((await status(a.test.secret_key)).statusCode).toBe(200);
    const c = await prisma.connection.findUniqueOrThrow({ where: { id: a.connection_id } });
    expect(c).toMatchObject({ revokedAt: null, replacedById: null });
  });

  it('A3: a connection replaced once cannot be replaced again (its key is 401)', async () => {
    const a = await connect();
    const b = await connectAt(NEW_SITE);
    const c = await connectAt('https://third.example.com');
    expect((await replace(a.test.secret_key, b.connection_id)).statusCode).toBe(200);
    expect((await replace(a.test.secret_key, c.connection_id)).statusCode).toBe(401);
  });

  // ─── revoke expires open sessions (A4) ──────────────────────────────────────

  async function openSessionOn(connectionId: string | null, livemode = false) {
    return (await createRow('Session', merchant.id, livemode, { connectionId })).id as string;
  }

  const sessionState = async (id: string) =>
    prisma.session.findUniqueOrThrow({
      where: { id },
      select: { status: true, expiredReason: true },
    });

  it('A4: disconnect expires the connection’s open sessions (both modes) unless a deposit is in flight', async () => {
    const a = await connect();
    const openTest = await openSessionOn(a.connection_id);
    const openLive = await openSessionOn(a.connection_id, true);
    const inFlight = (await createRow('Payment', merchant.id, false)).sessionId as string;
    await prisma.session.update({
      where: { id: inFlight },
      data: { connectionId: a.connection_id },
    });
    const handMade = await openSessionOn(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/connect/disconnect',
      headers: { authorization: `Bearer ${a.test.secret_key}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await sessionState(openTest)).toEqual({ status: 'EXPIRED', expiredReason: 'canceled' });
    expect(await sessionState(openLive)).toEqual({ status: 'EXPIRED', expiredReason: 'canceled' });
    expect((await sessionState(inFlight)).status).toBe('PENDING_DEPOSIT');
    expect((await sessionState(handMade)).status).toBe('PENDING_DEPOSIT');
    const expired = await prisma.event.findMany({
      where: { type: 'checkout.session.expired', aggregateId: { in: [openTest, openLive] } },
    });
    expect(expired).toHaveLength(2);
    const revoked = await prisma.event.findFirstOrThrow({
      where: { aggregateId: a.connection_id, type: 'connection.revoked', livemode: false },
    });
    expect(revoked.payload).toMatchObject({ expired_sessions: 2, sessions_in_flight: 1 });
  });

  it('A4: a dashboard removal expires open sessions, including those of a replaced predecessor', async () => {
    const a = await connect();
    const old = await openSessionOn(a.connection_id);
    const b = await connect(); // re-connect: A replaced by B; A's session stays open
    expect((await sessionState(old)).status).toBe('PENDING_DEPOSIT');
    const mine = await openSessionOn(b.connection_id);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/connections/${b.connection_id}`,
      headers: dashHeaders(admin, { merchantId: merchant.id }),
    });
    expect(res.statusCode).toBe(200);
    for (const id of [old, mine]) expect((await sessionState(id)).status).toBe('EXPIRED');
  });

  it('A4: removing an already replaced connection never touches its successor’s sessions', async () => {
    const a = await connect();
    const old = await openSessionOn(a.connection_id);
    await connect(); // A replaced
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/connections/${a.connection_id}`,
      headers: dashHeaders(admin, { merchantId: merchant.id }),
    });
    expect(res.statusCode).toBe(200);
    expect((await sessionState(old)).status).toBe('PENDING_DEPOSIT');
  });

  // ─── sessions are scoped to their connection (B1) ───────────────────────────

  it('B1: a connection key reads and expires only its own (or its predecessors’) sessions', async () => {
    const a = await connect();
    const aSession = await openSessionOn(a.connection_id);
    const blog = await connectAt(`${SITE}/blog`);
    const blogSession = await openSessionOn(blog.connection_id);
    const handMadeSession = await openSessionOn(null);
    const plain = await createApiKey(merchant.id, { livemode: false });

    const get = (key: string, id: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/checkout/sessions/${id}`,
        headers: { authorization: `Bearer ${key}` },
      });
    const expire = (key: string, id: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/checkout/sessions/${id}/expire`,
        headers: { authorization: `Bearer ${key}` },
      });

    expect((await get(a.test.secret_key, aSession)).statusCode).toBe(200);
    expect((await get(a.test.secret_key, blogSession)).statusCode).toBe(404);
    expect((await get(a.test.secret_key, handMadeSession)).statusCode).toBe(404);
    expect((await expire(a.test.secret_key, blogSession)).statusCode).toBe(404);
    expect((await sessionState(blogSession)).status).toBe('PENDING_DEPOSIT');
    // A hand-made key keeps acting on any session of its store.
    expect((await get(plain.raw, blogSession)).statusCode).toBe(200);
    expect((await get(plain.raw, aSession)).statusCode).toBe(200);

    // After a re-connect the successor speaks for the predecessor's sessions.
    const a2 = await connect();
    expect((await get(a2.test.secret_key, aSession)).statusCode).toBe(200);
    expect((await expire(a2.test.secret_key, aSession)).statusCode).toBe(200);
    expect((await get(a2.test.secret_key, blogSession)).statusCode).toBe(404);
  });
});
