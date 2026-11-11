import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { LOGIN_RECOVERY_EVENTS } from '../auth/login-recovery.js';
import { startEmailSignIn } from '../auth/magic-link.js';
import { nativePublicKey } from '../accounts/native-signing.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { onLoginRecoveryNotice } from '../jobs/login-recovery-notices.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { dashHeaders, loginAs, memoryMailer, responseCookies } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

describe('login recovery with saved code and fresh email proof', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    await resetDb();
    memoryMailer().clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  const post = (path: string, payload: object, headers = {}) =>
    app.inject({ method: 'POST', url: `/v1/auth/login-recovery/${path}`, payload, headers });
  async function prepared() {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const old = new SoftAuthenticator();
    const { credential } = await verifyRegistration(
      user,
      old.create(await registrationOptions(user)),
      'Lost device',
    );
    const session = await loginAs(user.id);
    const generated = await post('codes', {}, dashHeaders(session));
    expect(generated.statusCode).toBe(200);
    const codes = generated.json().codes as string[];
    return { user, old, credential, session, codes };
  }
  async function emailLink(email: string) {
    const r = await post('start', { email });
    expect(r.statusCode).toBe(202);
    const msg = memoryMailer()
      .sent.filter((m) => m.to === email && m.template === 'login_recovery_link')
      .at(-1)!;
    return new URLSearchParams(new URL(msg.data.url!).hash.slice(1)).get('token')!;
  }
  async function replacement(token: string, recoveryCode: string, auth = new SoftAuthenticator()) {
    const r = await post('options', { token, recoveryCode });
    expect(r.statusCode).toBe(200);
    return { auth, payload: { token, recoveryCode, response: auth.create(r.json()) } };
  }
  it('requires current passkey step-up and CSRF; stores only hashes and invalidates replaced codes', async () => {
    const p = await prepared();
    const weak = await loginAs(p.user.id, { stepUp: false });
    expect((await post('codes', {}, dashHeaders(weak))).json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await post('codes', {}, dashHeaders(p.session, { csrf: null }))).statusCode).toBe(403);
    const rows = await prisma.loginRecoveryCode.findMany();
    expect(rows).toHaveLength(10);
    expect(new Set(p.codes).size).toBe(10);
    for (const code of p.codes) expect(JSON.stringify(rows)).not.toContain(code);
    const view = await app.inject({
      method: 'GET',
      url: '/v1/auth/login-recovery/codes',
      headers: dashHeaders(p.session),
    });
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.json()).toMatchObject({ enabled: true, remaining: 10 });
    expect(view.json()).not.toHaveProperty('codes');
    const token = await emailLink(p.user.email);
    expect((await post('codes', {}, dashHeaders(p.session))).statusCode).toBe(200);
    expect((await post('options', { token, recoveryCode: p.codes[0] })).statusCode).toBe(401);
    expect(await prisma.loginRecoveryCode.count({ where: { revokedAt: null } })).toBe(10);
  });
  it('recovers the same identity and stores, revokes lost keys/sessions, preserves native wallet, and requires a new login', async () => {
    const p = await prepared();
    const store = await createMerchant();
    const member = await createRow('MerchantUser', store.id, false, {
      userId: p.user.id,
      role: 'owner',
    });
    const wallet = await createRow('NativeWallet', store.id, true, { ownerUserId: p.user.id });
    const accountsBefore = await prisma.merchantAccount.findMany();
    const usersBefore = await prisma.user.count();
    await startEmailSignIn(p.user.email);
    const oldEmailToken = new URL(memoryMailer().sent.at(-1)!.data.url!).searchParams.get('token');
    const token = await emailLink(p.user.email);
    const r = await replacement(token, p.codes[0]!);
    const completed = await post('verify', r.payload);
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ recovered: true });
    expect(responseCookies(completed.headers['set-cookie']).tendr_session).toBe('');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: dashHeaders(p.session) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: p.credential.id } }))
        .revokedAt,
    ).not.toBeNull();
    expect(await prisma.dashboardSession.count({ where: { revokedAt: null } })).toBe(0);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.merchantUser.findUnique({ where: { id: member.id } })).toEqual(member);
    expect(await prisma.nativeWallet.findUnique({ where: { id: wallet.id } })).toEqual(wallet);
    expect(await prisma.merchantAccount.findMany()).toEqual(accountsBefore);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/email/verify',
          payload: { token: oldEmailToken },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      await prisma.loginRecoveryCode.count({ where: { consumedAt: null, revokedAt: null } }),
    ).toBe(9);
    const options = () =>
      app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/options', payload: {} });
    const login = (response: object) =>
      app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/verify', payload: { response } });
    expect((await login(p.old.get((await options()).json()))).statusCode).toBe(401);
    const signed = await login(r.auth.get((await options()).json()));
    expect(signed.statusCode).toBe(200);
    expect(signed.json().user.id).toBe(p.user.id);
    const event = await prisma.event.findFirstOrThrow({
      where: { type: LOGIN_RECOVERY_EVENTS.completed },
    });
    await onLoginRecoveryNotice(event);
    await onLoginRecoveryNotice(event);
    expect(
      memoryMailer().sent.filter((m) => m.template === 'login_recovery_completed'),
    ).toHaveLength(1);
  });
  it('requires BOTH factors and binds a ceremony to the chosen code and person', async () => {
    const p = await prepared();
    const other = await prepared();
    const token = await emailLink(p.user.email);
    expect((await post('options', { token, recoveryCode: other.codes[0] })).statusCode).toBe(401);
    expect(
      (await post('options', { token: 'x'.repeat(43), recoveryCode: p.codes[0] })).statusCode,
    ).toBe(401);
    const r = await replacement(token, p.codes[0]!);
    expect((await post('verify', { ...r.payload, recoveryCode: p.codes[1] })).statusCode).toBe(401);
    const otherToken = await emailLink(other.user.email);
    await replacement(otherToken, other.codes[0]!);
    expect(
      (await post('verify', { ...r.payload, token: otherToken, recoveryCode: other.codes[0] }))
        .statusCode,
    ).toBe(401);
    expect((await post('verify', r.payload)).statusCode).toBe(200);
    expect(
      (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: other.credential.id } }))
        .revokedAt,
    ).toBeNull();
  });
  it('rejects expired emails and superseded/expired ceremonies without burning the saved code', async () => {
    const p = await prepared();
    const token = await emailLink(p.user.email);
    const first = await replacement(token, p.codes[0]!);
    const second = await replacement(token, p.codes[0]!);
    expect((await post('verify', first.payload)).statusCode).toBe(401);
    await prisma.loginRecoveryRequest.updateMany({ data: { challengeExpiresAt: new Date(0) } });
    expect((await post('verify', second.payload)).statusCode).toBe(401);
    await prisma.loginRecoveryRequest.updateMany({ data: { expiresAt: new Date(0) } });
    expect((await post('options', { token, recoveryCode: p.codes[0] })).statusCode).toBe(401);
    expect(await prisma.loginRecoveryCode.count({ where: { consumedAt: null } })).toBe(10);
    expect(
      (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: p.credential.id } }))
        .revokedAt,
    ).toBeNull();
  });
  it.each([{ userVerified: false }, { origin: 'https://attacker.example' }])(
    'requires WebAuthn UV, RP and origin validation: %j',
    async (config) => {
      const p = await prepared();
      const token = await emailLink(p.user.email);
      const r = await replacement(token, p.codes[0]!, new SoftAuthenticator(config));
      expect((await post('verify', r.payload)).statusCode).toBe(400);
      expect(await prisma.loginRecoveryCode.count({ where: { consumedAt: null } })).toBe(10);
    },
  );
  it('allows only one concurrent completion, rejects replay and keeps the used code spent on later requests', async () => {
    const p = await prepared();
    const token = await emailLink(p.user.email);
    const r = await replacement(token, p.codes[0]!);
    const results = await Promise.all([post('verify', r.payload), post('verify', r.payload)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect((await post('verify', r.payload)).statusCode).toBe(401);
    const later = await emailLink(p.user.email);
    expect((await post('options', { token: later, recoveryCode: p.codes[0] })).statusCode).toBe(
      401,
    );
    expect(
      await prisma.webauthnCredential.count({ where: { userId: p.user.id, revokedAt: null } }),
    ).toBe(1);
  });
  it('rejects a registration for another RP without consuming the code', async () => {
    const p = await prepared();
    const token = await emailLink(p.user.email);
    const options = (await post('options', { token, recoveryCode: p.codes[0] })).json();
    options.rp.id = 'attacker.example';
    const response = new SoftAuthenticator().create(options);
    expect((await post('verify', { token, recoveryCode: p.codes[0], response })).statusCode).toBe(
      400,
    );
    expect(await prisma.loginRecoveryCode.count({ where: { consumedAt: null } })).toBe(10);
  });
  it.each(['login credential', 'login public key', 'wallet public key'])(
    'rejects reuse of a %s without changing credentials or sessions',
    async (kind) => {
      const p = await prepared();
      const auth = kind.startsWith('login') ? p.old : new SoftAuthenticator();
      if (kind === 'login public key') auth.credentialId = Buffer.alloc(16, 11);
      if (kind === 'wallet public key') {
        const store = await createMerchant();
        const { x, y } = auth.rawPublicKey;
        await createRow('NativeWallet', store.id, true, {
          ownerUserId: p.user.id,
          publicKey: nativePublicKey(Buffer.concat([Buffer.from([4]), x, y!]).toString('base64')),
        });
      }
      const token = await emailLink(p.user.email);
      const r = await replacement(token, p.codes[0]!, auth);
      expect((await post('verify', r.payload)).statusCode).toBe(409);
      expect(await prisma.loginRecoveryCode.count({ where: { consumedAt: null } })).toBe(10);
      expect(
        await prisma.webauthnCredential.count({ where: { userId: p.user.id, revokedAt: null } }),
      ).toBe(1);
      expect(
        (await app.inject({ method: 'GET', url: '/v1/me', headers: dashHeaders(p.session) }))
          .statusCode,
      ).toBe(200);
    },
  );
  it('refuses a revoked in-flight registration session even if its cached step-up was valid', async () => {
    const p = await prepared();
    const token = await emailLink(p.user.email);
    const r = await replacement(token, p.codes[0]!);
    expect((await post('verify', r.payload)).statusCode).toBe(200);
    // Simulate an options request that already authenticated before revocation, then resumed.
    // Its fresh challenge was not present for recovery to invalidate; session recheck must reject it.
    const options = await registrationOptions(p.user);
    const session = await prisma.dashboardSession.findUniqueOrThrow({
      where: { tokenHash: (await import('../lib/crypto.js')).sha256(p.session.token) },
    });
    await expect(
      verifyRegistration(p.user, new SoftAuthenticator().create(options), null, {
        sessionId: session.id,
        steppedUp: true,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await prisma.webauthnCredential.count({ where: { revokedAt: null } })).toBe(1);
  });
  it('returns the same accepted response for an unknown account; throttles mail and fails closed without Redis', async () => {
    const p = await prepared();
    const unknown = await post('start', { email: 'unknown@example.com' });
    const known = await post('start', { email: p.user.email });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(memoryMailer().sent.filter((m) => m.template === 'login_recovery_link')).toHaveLength(1);
    await post('start', { email: p.user.email });
    await post('start', { email: p.user.email });
    expect((await post('start', { email: p.user.email })).statusCode).toBe(429);
    vi.spyOn(getRedis(), 'eval').mockRejectedValueOnce(new Error('offline'));
    expect((await post('start', { email: 'another@example.com' })).statusCode).toBe(503);
  });
  it('keeps the response generic and codes usable if email delivery fails', async () => {
    const p = await prepared();
    vi.spyOn(memoryMailer(), 'send').mockRejectedValueOnce(new Error('provider unavailable'));
    const result = await post('start', { email: p.user.email });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({ ok: true });
    expect(await prisma.loginRecoveryCode.count({ where: { consumedAt: null } })).toBe(10);
  });
});
