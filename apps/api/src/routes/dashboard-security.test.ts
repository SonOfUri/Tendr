import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { prisma } from '../lib/prisma.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { dashHeaders, loginAs, memoryMailer, type Login } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

async function personWithPasskey() {
  const user = await createUser({ emailVerifiedAt: new Date() });
  const auth = new SoftAuthenticator();
  const options = await registrationOptions(user);
  const cred = await verifyRegistration(user, auth.create(options), 'Phone');
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

  it('a person with a passkey cannot get an email login, and the answer looks the same', async () => {
    const { user } = await personWithPasskey();
    const known = await post('/v1/auth/email/start', {}, { email: user.email });
    const unknown = await post('/v1/auth/email/start', {}, { email: 'fresh@example.com' });
    expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(known.json()).toEqual(unknown.json());
    expect(memoryMailer().sent.map((x) => x.to)).toEqual(['fresh@example.com']);
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
