// R31 (the CSRF value in session responses) and the dashboard's read routes added for the team,
// money-out and security screens: a member's signer keys, saved addresses, limits.
import type { Merchant } from '@prisma/client';
import { CSRF_HEADER, SESSION_COOKIE, type MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
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
  createCredential,
  createMerchant,
  createRow,
  createUser,
  resetDb,
} from '../test/helpers.js';

describe('dashboard reads and the CSRF token in session responses', () => {
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

  const post = (url: string, headers: Record<string, string>, payload: object = {}) =>
    app.inject({ method: 'POST', url, headers, payload });

  /** Only the session cookie (no readable CSRF cookie) plus `Tendr-CSRF: csrf`. */
  const tokenOnly = (sessionToken: string, csrf?: string): Record<string, string> => ({
    cookie: `${SESSION_COOKIE}=${sessionToken}`,
    ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
  });

  describe('R31: csrfToken', () => {
    it('every session response returns a token the API accepts without the CSRF cookie', async () => {
      // Email verify starts the session.
      await post('/v1/auth/email/start', {}, { email: 'owner@example.com' });
      const verify = await post(
        '/v1/auth/email/verify',
        {},
        { token: tokenFromMail('owner@example.com', 'verify_email') },
      );
      expect(verify.statusCode, verify.body).toBe(200);
      const cookies = responseCookies(verify.headers['set-cookie']);
      const session = cookies[SESSION_COOKIE]!;
      const csrf = verify.json().csrfToken as string;
      expect(csrf).toBe(cookies.tendr_csrf);

      // Mutations with only the session cookie: refused without the header, accepted with it.
      const auth = new SoftAuthenticator();
      expect(
        (await post('/v1/auth/passkeys/register/options', tokenOnly(session))).statusCode,
      ).toBe(403);
      const options = await post('/v1/auth/passkeys/register/options', tokenOnly(session, csrf));
      expect(options.statusCode, options.body).toBe(200);
      const reg = await post('/v1/auth/passkeys/register/verify', tokenOnly(session, csrf), {
        response: auth.create(options.json()),
      });
      expect(reg.statusCode, reg.body).toBe(200);
      expect(reg.json().csrfToken).toBe(csrf);

      // GET /v1/me returns the same value.
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: tokenOnly(session) });
      expect(me.json().csrfToken).toBe(csrf);

      // Step-up verify answers with it too.
      const su = await post('/v1/auth/passkeys/step-up/options', tokenOnly(session, csrf));
      const stepped = await post('/v1/auth/passkeys/step-up/verify', tokenOnly(session, csrf), {
        response: auth.get(su.json()),
      });
      expect(stepped.statusCode, stepped.body).toBe(200);
      expect(stepped.json().csrfToken).toBe(csrf);

      // Passkey login: a new session, a new token; the old one does not fit the new session.
      const lo = await post('/v1/auth/passkeys/login/options', {}, {});
      const login = await post(
        '/v1/auth/passkeys/login/verify',
        {},
        {
          response: auth.get(lo.json()),
        },
      );
      expect(login.statusCode, login.body).toBe(200);
      const newSession = responseCookies(login.headers['set-cookie'])[SESSION_COOKIE]!;
      const newCsrf = login.json().csrfToken as string;
      expect(newCsrf).not.toBe(csrf);
      const created = await post('/v1/merchants', tokenOnly(newSession, newCsrf), {
        name: 'Acme',
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(
        (await post('/v1/merchants', tokenOnly(newSession, csrf), { name: 'Other' })).statusCode,
      ).toBe(403);
    });
  });

  describe('read routes', () => {
    let merchant: Merchant;
    let owner: Login;

    async function member(role: MerchantUserRole, m: Merchant = merchant) {
      const user = await createUser({ emailVerifiedAt: new Date() });
      await createCredential(user.id);
      const membership = await createRow('MerchantUser', m.id, false, {
        userId: user.id,
        role,
        isSigner: false,
      });
      return { user, membership, login: await loginAs(user.id) };
    }
    const get = (url: string, login: Login, livemode = false, m: Merchant = merchant) =>
      app.inject({
        method: 'GET',
        url,
        headers: dashHeaders(login, { merchantId: m.id, livemode }),
      });

    beforeEach(async () => {
      merchant = await createMerchant();
      owner = (await member('owner')).login;
      await createRow('MerchantAccount', merchant.id, false, { status: 'active' });
    });

    it("signer-keys: a member's active passkey keys, owner/admin only, this store only", async () => {
      const target = await member('finance');
      const second = await createCredential(target.user.id);
      const revoked = await createCredential(target.user.id, { revokedAt: new Date() });
      const url = `/v1/team/${target.membership.id}/signer-keys`;

      const res = await get(url, owner);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        membershipId: target.membership.id,
        userId: target.user.id,
        role: 'finance',
        isSigner: false,
      });
      expect(body.keys).toHaveLength(2);
      expect(body.keys).toContainEqual(second.publicKey);
      expect(body.keys).not.toContainEqual(revoked.publicKey);

      expect((await get(url, (await member('admin')).login)).statusCode).toBe(200);
      expect((await get(url, (await member('finance')).login)).statusCode).toBe(403);
      expect((await get(url, (await member('viewer')).login)).statusCode).toBe(403);

      // Another store's owner cannot read this store's member (404, no hint).
      const other = await createMerchant();
      const otherOwner = await member('owner', other);
      expect((await get(url, otherOwner.login, false, other)).statusCode).toBe(404);
    });

    it('saved addresses: pending until activeFrom, active after, revoked kept; per mode', async () => {
      const soon = new Date(Date.now() + 24 * 3_600_000);
      await createRow('PayoutAllowlistEntry', merchant.id, false, {
        chain: 'eth',
        address: '0xabc',
        activeFrom: soon,
      });
      await createRow('PayoutAllowlistEntry', merchant.id, false, {
        chain: 'near',
        address: 'shop.near',
        status: 'active',
        activeFrom: new Date(Date.now() - 1000),
      });
      await createRow('PayoutAllowlistEntry', merchant.id, false, {
        chain: 'near',
        address: 'old.near',
        status: 'revoked',
      });
      await createRow('PayoutAllowlistEntry', merchant.id, true, { address: 'live.near' });

      const res = await get('/v1/account/saved-addresses', (await member('viewer')).login);
      expect(res.statusCode, res.body).toBe(200);
      const rows = res.json().savedAddresses as { address: string; status: string }[];
      expect(rows.map((r) => [r.address, r.status])).toEqual([
        ['0xabc', 'pending'],
        ['shop.near', 'active'],
        ['old.near', 'revoked'],
      ]);
      expect(res.body).not.toContain('live.near');
    });

    it('limits: the account_limits mirror, amounts as strings', async () => {
      await createRow('AccountLimit', merchant.id, false, {
        asset: 'nep141:usdc.near',
        perTx: '1000000',
        perDay: null,
        refundCap: '5000000',
        sweepTriggerAbove: '9000000',
        sweepKeep: '1000000',
        sweepSavedAddressId: 'pal_x',
        sweepChain: 'near',
        sweepAddress: 'shop.near',
      });
      const res = await get('/v1/account/limits', owner);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().limits).toEqual([
        {
          asset: 'nep141:usdc.near',
          perTx: '1000000',
          perDay: null,
          refundCap: '5000000',
          autoSweep: {
            triggerAbove: '9000000',
            keep: '1000000',
            savedAddressId: 'pal_x',
            chain: 'near',
            address: 'shop.near',
          },
        },
      ]);
    });
  });
});
