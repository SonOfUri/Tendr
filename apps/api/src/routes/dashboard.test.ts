import type { Merchant, User } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { principalRef, requirePrincipal } from '../gateway/principal.js';
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
import {
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
} from '../test/helpers.js';

/** Throwaway routes for principal resolution and mode isolation. */
function testRoutes(app: FastifyInstance) {
  app.get(
    '/v1/test/dash/links',
    { config: { auth: { principals: ['dashboard_user'] } } },
    async (req) => {
      const p = requirePrincipal(req);
      const links = await req.db!.paymentLink.findMany({ select: { id: true } });
      return { ref: principalRef(p), principal: p, links: links.map((l) => l.id) };
    },
  );
  app.post(
    '/v1/test/dash/request-money',
    { config: { auth: { principals: ['dashboard_user'], permission: 'money:request' } } },
    async () => ({ ok: true }),
  );
}

async function member(
  merchant: Merchant,
  role: MerchantUserRole,
  opts: { isSigner?: boolean; user?: User } = {},
) {
  const user = opts.user ?? (await createUser({ emailVerifiedAt: new Date() }));
  const membership = await createRow('MerchantUser', merchant.id, false, {
    userId: user.id,
    role,
    isSigner: opts.isSigner ?? false,
  });
  return { user, membership, login: await loginAs(user.id) };
}

describe('dashboard auth, signup, team and invites', () => {
  let app: FastifyInstance;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    memoryMailer().clear();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp({ extraRoutes: testRoutes });
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
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('signs up end to end: email → session → passkey → store, then logs in by passkey', async () => {
    const start = await post('/v1/auth/email/start', {}, { email: 'Owner@Example.com' });
    expect(start.statusCode).toBe(202);
    const token = tokenFromMail('owner@example.com', 'verify_email');

    const verify = await post('/v1/auth/email/verify', {}, { token });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      user: { email: 'owner@example.com' },
      hasPasskey: false,
    });
    const setCookie = verify.headers['set-cookie'] as string[];
    const sessionCookie = setCookie.find((c) => c.startsWith('tendr_session='))!;
    expect(sessionCookie).toMatch(/HttpOnly/);
    expect(sessionCookie).toMatch(/SameSite=Lax/);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).not.toMatch(/Secure/); // NODE_ENV=test
    const csrfCookie = setCookie.find((c) => c.startsWith('tendr_csrf='))!;
    expect(csrfCookie).not.toMatch(/HttpOnly/);
    const cookies = responseCookies(setCookie);
    const login: Login = {
      token: cookies.tendr_session!,
      csrf: cookies.tendr_csrf!,
      userId: verify.json().user.id,
    };
    // Only the token's hash is stored.
    const session = await prisma.dashboardSession.findFirstOrThrow();
    expect(session.tokenHash).not.toBe(login.token);

    // No store before a passkey exists.
    const early = await post('/v1/merchants', dashHeaders(login), { name: 'Acme' });
    expect(early.statusCode).toBe(409);

    const auth = new SoftAuthenticator();
    const regOptions = await post('/v1/auth/passkeys/register/options', dashHeaders(login));
    expect(regOptions.statusCode).toBe(200);
    const reg = await post('/v1/auth/passkeys/register/verify', dashHeaders(login), {
      response: auth.create(regOptions.json()),
      deviceLabel: 'MacBook',
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.json().credential).toMatchObject({ deviceLabel: 'MacBook' });

    const created = await post('/v1/merchants', dashHeaders(login), { name: 'Acme' });
    expect(created.statusCode).toBe(201);
    const store = created.json();
    expect(store).toMatchObject({ name: 'Acme', slug: 'acme', role: 'owner', isSigner: true });

    const me = await get('/v1/me', dashHeaders(login));
    expect(me.json()).toMatchObject({
      user: { id: login.userId, email: 'owner@example.com' },
      stores: [{ id: store.id, name: 'Acme', slug: 'acme', role: 'owner', isSigner: true }],
      passkeys: [{ deviceLabel: 'MacBook' }],
    });
    expect((await get(`/v1/merchants/${store.id}`, dashHeaders(login))).json()).toMatchObject({
      id: store.id,
      role: 'owner',
    });

    // Passkey login creates a fresh session.
    const loginOptions = await post(
      '/v1/auth/passkeys/login/options',
      {},
      {
        email: 'owner@example.com',
      },
    );
    const loggedIn = await post(
      '/v1/auth/passkeys/login/verify',
      {},
      {
        response: auth.get(loginOptions.json()),
      },
    );
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().user.id).toBe(login.userId);
    expect(responseCookies(loggedIn.headers['set-cookie']).tendr_session).toBeTruthy();
    expect(await prisma.dashboardSession.count()).toBe(2);
  });

  it('email/start answers the same whether or not the person exists', async () => {
    await createUser({ email: 'known@example.com', emailVerifiedAt: new Date() });
    const a = await post('/v1/auth/email/start', {}, { email: 'known@example.com' });
    const b = await post('/v1/auth/email/start', {}, { email: 'unknown@example.com' });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(a.json()).toEqual(b.json());
    expect((await post('/v1/auth/email/start', {}, { email: 'nope' })).statusCode).toBe(400);
  });

  it('person routes need a live session; logout revokes it', async () => {
    expect((await get('/v1/me')).statusCode).toBe(401);
    const user = await createUser();
    const login = await loginAs(user.id);
    expect((await get('/v1/me', dashHeaders(login))).statusCode).toBe(200);

    const out = await post('/v1/auth/logout', dashHeaders(login));
    expect(out.statusCode).toBe(204);
    expect(responseCookies(out.headers['set-cookie']).tendr_session).toBe('');
    expect((await get('/v1/me', dashHeaders(login))).statusCode).toBe(401);

    const stale = await loginAs(user.id);
    await prisma.dashboardSession.updateMany({
      where: { revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect((await get('/v1/me', dashHeaders(stale))).statusCode).toBe(401);
  });

  it('csrf_required_on_cookie_mutations', async () => {
    const user = await createUser();
    await createCredential(user.id);
    const login = await loginAs(user.id);
    const missing = await post('/v1/merchants', dashHeaders(login, { csrf: null }), { name: 'A' });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('FORBIDDEN');
    const wrong = await post('/v1/merchants', dashHeaders(login, { csrf: 'x'.repeat(43) }), {
      name: 'A',
    });
    expect(wrong.statusCode).toBe(403);
    // Another session's CSRF value does not work either: it is bound to the session token.
    const other = await loginAs(user.id);
    const crossed = await post('/v1/merchants', dashHeaders(login, { csrf: other.csrf }), {
      name: 'A',
    });
    expect(crossed.statusCode).toBe(403);
    expect(await prisma.merchant.count()).toBe(0);
    // Reads need no CSRF header.
    expect((await get('/v1/me', dashHeaders(login, { csrf: null }))).statusCode).toBe(200);
    // With it, the mutation goes through.
    expect((await post('/v1/merchants', dashHeaders(login), { name: 'Acme' })).statusCode).toBe(
      201,
    );
  });

  it('dashboard_user_requires_membership_for_header_merchant', async () => {
    const mine = await createMerchant();
    const theirs = await createMerchant();
    const { login, membership } = await member(mine, 'finance', { isSigner: true });

    const ok = await get('/v1/test/dash/links', dashHeaders(login, { merchantId: mine.id }));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().principal).toMatchObject({
      kind: 'dashboard_user',
      merchantId: mine.id,
      livemode: false,
      userId: login.userId,
      membershipId: membership.id,
      role: 'finance',
      isSigner: true,
      permissions: ['account:read', 'money:request'],
    });
    // Rate limits and idempotency key off the membership.
    expect(ok.json().ref).toBe(membership.id);

    const foreign = await get('/v1/test/dash/links', dashHeaders(login, { merchantId: theirs.id }));
    expect(foreign.statusCode).toBe(403);
    const noHeader = await get('/v1/test/dash/links', dashHeaders(login));
    expect(noHeader.statusCode).toBe(400);
    const badMode = await get('/v1/test/dash/links', {
      ...dashHeaders(login, { merchantId: mine.id }),
      'tendr-livemode': 'yes',
    });
    expect(badMode.statusCode).toBe(400);
    // A suspended store refuses its members.
    await prisma.merchant.update({ where: { id: mine.id }, data: { status: 'suspended' } });
    expect(
      (await get('/v1/test/dash/links', dashHeaders(login, { merchantId: mine.id }))).statusCode,
    ).toBe(403);
    // API keys never reach dashboard routes, and cookies never reach API-key routes.
    const { raw } = await createApiKey(theirs.id, { livemode: false });
    expect((await get('/v1/test/dash/links', { authorization: `Bearer ${raw}` })).statusCode).toBe(
      403,
    );
    expect((await get('/v1/ping', dashHeaders(login, { merchantId: theirs.id }))).statusCode).toBe(
      401,
    );
  });

  it('livemode_header_isolates_rows', async () => {
    const m = await createMerchant();
    const { login } = await member(m, 'viewer');
    const test = await createRow('PaymentLink', m.id, false);
    const live = await createRow('PaymentLink', m.id, true);
    const inTest = await get('/v1/test/dash/links', dashHeaders(login, { merchantId: m.id }));
    expect(inTest.json().links).toEqual([test.id]);
    const inLive = await get(
      '/v1/test/dash/links',
      dashHeaders(login, { merchantId: m.id, livemode: true }),
    );
    expect(inLive.json().links).toEqual([live.id]);
  });

  it('route permissions are checked against the role', async () => {
    const m = await createMerchant();
    const viewer = await member(m, 'viewer');
    const finance = await member(m, 'finance');
    const url = '/v1/test/dash/request-money';
    const denied = await post(url, dashHeaders(viewer.login, { merchantId: m.id }));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/money:request/);
    expect((await post(url, dashHeaders(finance.login, { merchantId: m.id }))).statusCode).toBe(
      200,
    );
    // team:manage gates invites.
    const invite = await post(
      '/v1/team/invites',
      dashHeaders(finance.login, { merchantId: m.id }),
      {
        email: 'x@example.com',
        role: 'viewer',
      },
    );
    expect(invite.statusCode).toBe(403);
  });

  it('lists the team with emails, for this store only', async () => {
    const m = await createMerchant();
    const other = await createMerchant();
    const owner = await member(m, 'owner', { isSigner: true });
    const viewer = await member(m, 'viewer');
    await member(other, 'owner');
    await createRow('MerchantInvite', other.id, false);
    const res = await get('/v1/team', dashHeaders(viewer.login, { merchantId: m.id }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(2);
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: owner.membership.id,
          email: owner.user.email,
          role: 'owner',
          isSigner: true,
        }),
        expect.objectContaining({ id: viewer.membership.id, email: viewer.user.email }),
      ]),
    );
    expect(body.invites).toEqual([]);
  });

  it('invite_existing_person_joins_without_new_user', async () => {
    const m = await createMerchant({ name: 'Second Store' });
    const admin = await member(m, 'admin');
    // An owner of another store, with a passkey already.
    const elsewhere = await createMerchant();
    const existing = await member(elsewhere, 'owner', { isSigner: true });
    const cred = await createCredential(existing.user.id);

    const created = await post('/v1/team/invites', dashHeaders(admin.login, { merchantId: m.id }), {
      email: existing.user.email.toUpperCase(),
      role: 'finance',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: existing.user.email, role: 'finance' });
    expect(created.json()).not.toHaveProperty('token');
    expect(created.json()).not.toHaveProperty('tokenHash');
    const mail = memoryMailer().sent.find((x) => x.template === 'invite')!;
    expect(mail.data.url).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = tokenFromMail(existing.user.email, 'invite');
    const stored = await prisma.merchantInvite.findFirstOrThrow({ where: { merchantId: m.id } });
    expect(stored.tokenHash).not.toBe(token);

    const usersBefore = await prisma.user.count();
    const accepted = await post('/v1/invites/accept', dashHeaders(existing.login), { token });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ merchantId: m.id, role: 'finance', isSigner: false });
    expect(await prisma.user.count()).toBe(usersBefore);
    const memberships = await prisma.merchantUser.findMany({ where: { userId: existing.user.id } });
    expect(memberships.map((x) => x.merchantId).sort()).toEqual([elsewhere.id, m.id].sort());
    // Their passkey is untouched and now works for both stores.
    expect(
      (await prisma.webauthnCredential.findUniqueOrThrow({ where: { id: cred.id } })).revokedAt,
    ).toBeNull();
    // Single use.
    const again = await post('/v1/invites/accept', dashHeaders(existing.login), { token });
    expect(again.statusCode).toBe(404);
  });

  it('invite_accept_requires_matching_verified_email', async () => {
    const m = await createMerchant();
    const admin = await member(m, 'admin');
    await post('/v1/team/invites', dashHeaders(admin.login, { merchantId: m.id }), {
      email: 'invitee@example.com',
      role: 'viewer',
    });
    const token = tokenFromMail('invitee@example.com', 'invite');

    const stranger = await createUser({ emailVerifiedAt: new Date() });
    const wrong = await post('/v1/invites/accept', dashHeaders(await loginAs(stranger.id)), {
      token,
    });
    expect(wrong.statusCode).toBe(403);

    const unverified = await createUser({ email: 'invitee@example.com' });
    const notYet = await post('/v1/invites/accept', dashHeaders(await loginAs(unverified.id)), {
      token,
    });
    expect(notYet.statusCode).toBe(403);

    await prisma.user.update({
      where: { id: unverified.id },
      data: { emailVerifiedAt: new Date() },
    });
    await prisma.merchantInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    const expired = await post('/v1/invites/accept', dashHeaders(await loginAs(unverified.id)), {
      token,
    });
    expect(expired.statusCode).toBe(404);
    expect(await prisma.merchantUser.count({ where: { userId: unverified.id } })).toBe(0);
  });

  it('only owners invite owners; members cannot be invited twice', async () => {
    const m = await createMerchant();
    const admin = await member(m, 'admin');
    const owner = await member(m, 'owner');
    const asAdmin = await post('/v1/team/invites', dashHeaders(admin.login, { merchantId: m.id }), {
      email: 'new@example.com',
      role: 'owner',
    });
    expect(asAdmin.statusCode).toBe(403);
    const asOwner = await post('/v1/team/invites', dashHeaders(owner.login, { merchantId: m.id }), {
      email: 'new@example.com',
      role: 'owner',
    });
    expect(asOwner.statusCode).toBe(201);
    const dupe = await post('/v1/team/invites', dashHeaders(owner.login, { merchantId: m.id }), {
      email: admin.user.email,
      role: 'viewer',
    });
    expect(dupe.statusCode).toBe(409);
  });

  it('role_change_by_admin_cannot_touch_owner', async () => {
    const m = await createMerchant();
    const owner = await member(m, 'owner', { isSigner: true });
    const admin = await member(m, 'admin');
    const viewer = await member(m, 'viewer');
    const patch = (login: Login, membershipId: string, role: string) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/team/${membershipId}`,
        headers: dashHeaders(login, { merchantId: m.id }),
        payload: { role },
      });

    expect((await patch(admin.login, owner.membership.id, 'viewer')).statusCode).toBe(403);
    expect((await patch(admin.login, viewer.membership.id, 'owner')).statusCode).toBe(403);
    const promoted = await patch(admin.login, viewer.membership.id, 'finance');
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ id: viewer.membership.id, role: 'finance' });

    // The last owner cannot be demoted, even by themself.
    expect((await patch(owner.login, owner.membership.id, 'admin')).statusCode).toBe(409);
    // A signer cannot become a viewer (remove the signer by proposal first).
    expect((await patch(owner.login, owner.membership.id, 'viewer')).statusCode).toBe(409);
    expect((await patch(owner.login, admin.membership.id, 'owner')).statusCode).toBe(200);
    // A membership of another store is not found.
    const other = await createMerchant();
    const outsider = await member(other, 'viewer');
    expect((await patch(owner.login, outsider.membership.id, 'admin')).statusCode).toBe(404);
    // is_signer is not settable here.
    const sneaky = await app.inject({
      method: 'PATCH',
      url: `/v1/team/${viewer.membership.id}`,
      headers: dashHeaders(owner.login, { merchantId: m.id }),
      payload: { role: 'finance', isSigner: true },
    });
    expect(sneaky.statusCode).toBe(400);
  });

  it('removes own passkeys only, never the last one', async () => {
    const user = await createUser();
    const a = await createCredential(user.id);
    const b = await createCredential(user.id);
    const other = await createUser();
    const theirs = await createCredential(other.id);
    const login = await loginAs(user.id);
    const del = (id: string) =>
      app.inject({ method: 'DELETE', url: `/v1/auth/passkeys/${id}`, headers: dashHeaders(login) });

    expect((await del(theirs.id)).statusCode).toBe(404);
    expect((await del(a.id)).statusCode).toBe(204);
    expect((await del(b.id)).statusCode).toBe(409);
    const me = await get('/v1/me', dashHeaders(login));
    expect(me.json().passkeys.map((p: { id: string }) => p.id)).toEqual([b.id]);
  });

  it('GET /v1/merchants/:id is limited to stores the person belongs to', async () => {
    const m = await createMerchant();
    const other = await createMerchant();
    const { login } = await member(m, 'viewer');
    expect((await get(`/v1/merchants/${m.id}`, dashHeaders(login))).statusCode).toBe(200);
    expect((await get(`/v1/merchants/${other.id}`, dashHeaders(login))).statusCode).toBe(404);
  });
});
