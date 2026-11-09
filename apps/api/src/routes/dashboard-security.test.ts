import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { prisma } from '../lib/prisma.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import {
  dashHeaders,
  loginAs,
  memoryMailer,
  responseCookies,
  tokenFromMail,
  type Login,
} from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

async function personWithPasskey() {
  const user = await createUser({ emailVerifiedAt: new Date() });
  const auth = new SoftAuthenticator();
  const options = await registrationOptions(user);
  const { credential: cred } = await verifyRegistration(user, auth.create(options), 'Phone');
  return { user, auth, cred };
}

describe('dashboard step-up and hardening', () => {
  let app: FastifyInstance;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    memoryMailer().clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: payload as object });

  const expectStepUp = (res: { statusCode: number; json: () => { error: { code: string } } }) => {
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
  };

  async function teamOf(merchant: Merchant, stepUp: boolean) {
    const { user, auth } = await personWithPasskey();
    const owner = await createRow('MerchantUser', merchant.id, false, {
      userId: user.id,
      role: 'owner',
      isSigner: true,
    });
    const viewer = await createRow('MerchantUser', merchant.id, false, { role: 'viewer' });
    return { user, auth, owner, viewer, login: await loginAs(user.id, { stepUp }) };
  }

  it('sensitive actions need a passkey assertion from the last 10 minutes', async () => {
    const m = await createMerchant();
    const { login, viewer, auth, user } = await teamOf(m, false);
    const store = dashHeaders(login, { merchantId: m.id });

    expectStepUp(await post('/v1/team/invites', store, { email: 'a@example.com', role: 'viewer' }));
    expectStepUp(
      await app.inject({
        method: 'PATCH',
        url: `/v1/team/${viewer.id}`,
        headers: store,
        payload: { role: 'finance' },
      }),
    );
    // A second passkey and passkey removal too (the person already has one).
    expectStepUp(await post('/v1/auth/passkeys/register/options', dashHeaders(login)));
    const cred = await prisma.webauthnCredential.findFirstOrThrow({ where: { userId: user.id } });
    expectStepUp(
      await app.inject({
        method: 'DELETE',
        url: `/v1/auth/passkeys/${cred.id}`,
        headers: dashHeaders(login),
      }),
    );
    // Reads are not stepped up.
    expect((await app.inject({ url: '/v1/team', headers: store })).statusCode).toBe(200);

    // Step up with the passkey.
    const options = await post('/v1/auth/passkeys/step-up/options', dashHeaders(login));
    expect(options.statusCode).toBe(200);
    expect(options.json().allowCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);
    const verified = await post('/v1/auth/passkeys/step-up/verify', dashHeaders(login), {
      response: auth.get(options.json()),
    });
    expect(verified.statusCode).toBe(200);
    expect(
      (await post('/v1/team/invites', store, { email: 'a@example.com', role: 'viewer' }))
        .statusCode,
    ).toBe(201);

    // Ten minutes later it has lapsed again.
    await prisma.dashboardSession.updateMany({
      data: { passkeyVerifiedAt: new Date(Date.now() - 10 * 60_000 - 1000) },
    });
    expectStepUp(await post('/v1/team/invites', store, { email: 'b@example.com', role: 'viewer' }));
  });

  it("a step-up must be the session's own person's passkey", async () => {
    const m = await createMerchant();
    const { login } = await teamOf(m, false);
    const mallory = await personWithPasskey();
    const options = await post('/v1/auth/passkeys/step-up/options', dashHeaders(login));
    const res = await post('/v1/auth/passkeys/step-up/verify', dashHeaders(login), {
      response: mallory.auth.get(options.json()),
    });
    expect(res.statusCode).toBe(401);
    const session = await prisma.dashboardSession.findFirstOrThrow({
      where: { userId: login.userId },
    });
    expect(session.passkeyVerifiedAt).toBeNull();
  });

  it('the first passkey registered on an email session counts as a fresh assertion', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const login: Login = await loginAs(user.id, { stepUp: false });
    const first = new SoftAuthenticator();
    const o1 = await post('/v1/auth/passkeys/register/options', dashHeaders(login));
    expect(o1.statusCode).toBe(200);
    const r1 = await post('/v1/auth/passkeys/register/verify', dashHeaders(login), {
      response: first.create(o1.json()),
    });
    expect(r1.statusCode).toBe(200);
    // Within the window, a second device can be added straight away.
    const second = new SoftAuthenticator();
    const o2 = await post('/v1/auth/passkeys/register/options', dashHeaders(login));
    expect(o2.statusCode).toBe(200);
    const r2 = await post('/v1/auth/passkeys/register/verify', dashHeaders(login), {
      response: second.create(o2.json()),
    });
    expect(r2.statusCode).toBe(200);
  });

  it("registering a person's first passkey ends their other sessions", async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const here: Login = await loginAs(user.id, { stepUp: false });
    const elsewhere: Login = await loginAs(user.id, { stepUp: false });
    const auth = new SoftAuthenticator();
    const options = await post('/v1/auth/passkeys/register/options', dashHeaders(here));
    const res = await post('/v1/auth/passkeys/register/verify', dashHeaders(here), {
      response: auth.create(options.json()),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: dashHeaders(here) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/me', headers: dashHeaders(elsewhere) })).statusCode).toBe(
      401,
    );
    const live = await prisma.dashboardSession.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
  });

  it('two passkey-less sessions racing to register cannot both count as the first', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const one: Login = await loginAs(user.id, { stepUp: false });
    const two: Login = await loginAs(user.id, { stepUp: false });
    const [a, b] = [new SoftAuthenticator(), new SoftAuthenticator()];
    const oa = await post('/v1/auth/passkeys/register/options', dashHeaders(one));
    const ob = await post('/v1/auth/passkeys/register/options', dashHeaders(two));
    const results = await Promise.all([
      post('/v1/auth/passkeys/register/verify', dashHeaders(one), {
        response: a.create(oa.json()),
      }),
      post('/v1/auth/passkeys/register/verify', dashHeaders(two), {
        response: b.create(ob.json()),
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await prisma.webauthnCredential.count({ where: { userId: user.id } })).toBe(1);
    // Only the winner's session is stepped up (and alive).
    const live = await prisma.dashboardSession.findMany({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]!.passkeyVerifiedAt).not.toBeNull();
  });

  it('email fallback restores the existing account without granting passkey step-up or changing keys', async () => {
    const { user, cred } = await personWithPasskey();
    const merchant = await createMerchant();
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role: 'owner' });
    const originalSession = await loginAs(user.id);
    const peopleBefore = await prisma.user.count();
    const known = await post('/v1/auth/email/start', {}, { email: user.email });
    const unknown = await post('/v1/auth/email/start', {}, { email: 'fresh@example.com' });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.json()).toEqual(unknown.json());
    expect(memoryMailer().sent.map((x) => x.to)).toEqual([user.email, 'fresh@example.com']);
    const token = tokenFromMail(user.email, 'login_link');
    const verified = await post('/v1/auth/email/verify', {}, { token });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ user: { id: user.id }, hasPasskey: true });
    const cookies = responseCookies(verified.headers['set-cookie']);
    const login: Login = {
      token: cookies.tendr_session!,
      csrf: cookies.tendr_csrf!,
      userId: user.id,
    };
    expect(login.token).not.toBe(originalSession.token);
    const me = await app.inject({ url: '/v1/me', headers: dashHeaders(login) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { id: user.id },
      stores: [{ id: merchant.id }],
      passkeys: [{ id: cred.id }],
    });
    expect(
      (await app.inject({ url: '/v1/me', headers: dashHeaders(originalSession) })).statusCode,
    ).toBe(200);
    const sessions = await prisma.dashboardSession.findMany({ where: { userId: user.id } });
    expect(sessions.filter((s) => s.passkeyVerifiedAt === null)).toHaveLength(1);
    expectStepUp(await post('/v1/auth/passkeys/register/options', dashHeaders(login)));
    expectStepUp(
      await app.inject({
        method: 'DELETE',
        url: `/v1/auth/passkeys/${cred.id}`,
        headers: dashHeaders(login),
      }),
    );
    expectStepUp(
      await post('/v1/team/invites', dashHeaders(login, { merchantId: merchant.id }), {
        email: 'another@example.com',
        role: 'owner',
      }),
    );
    expect((await post('/v1/auth/email/verify', {}, { token })).statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(peopleBefore);
    expect(
      await prisma.webauthnCredential.count({ where: { userId: user.id, revokedAt: null } }),
    ).toBe(1);
  });

  it('passkey login sessions start stepped up; revoking a passkey ends other sessions', async () => {
    const { user, auth } = await personWithPasskey();
    const second = new SoftAuthenticator();
    await verifyRegistration(user, second.create(await registrationOptions(user)), null);
    const options = await post('/v1/auth/passkeys/login/options', {}, {});
    const res = await post(
      '/v1/auth/passkeys/login/verify',
      {},
      { response: auth.get(options.json()) },
    );
    expect(res.statusCode).toBe(200);
    const elsewhere = await loginAs(user.id);
    const current = await prisma.dashboardSession.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(current.passkeyVerifiedAt).not.toBeNull();
    // Delete the second passkey from the `elsewhere` session: the login session is ended.
    const cred = await prisma.webauthnCredential.findFirstOrThrow({
      where: { credentialId: second.id },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/passkeys/${cred.id}`,
      headers: dashHeaders(elsewhere),
    });
    expect(del.statusCode).toBe(204);
    const sessions = await prisma.dashboardSession.findMany({ where: { userId: user.id } });
    expect(sessions.filter((x) => x.revokedAt === null)).toHaveLength(1);
    expect((await app.inject({ url: '/v1/me', headers: dashHeaders(elsewhere) })).statusCode).toBe(
      200,
    );
  });

  it('refuses at startup a route that pairs a permission with non-dashboard principals', async () => {
    const bad = await buildApp({
      extraRoutes: (a) => {
        a.get(
          '/v1/test/mixed',
          {
            config: {
              auth: { principals: ['secret_key', 'dashboard_user'], permission: 'money:request' },
            },
          },
          async () => ({ ok: true }),
        );
      },
    });
    await expect(bad.ready()).rejects.toThrow(
      /invalid auth config.*\/v1\/test\/mixed \(permission/,
    );
    await bad.close();
  });
});
