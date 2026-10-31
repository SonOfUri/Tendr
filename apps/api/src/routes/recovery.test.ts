import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { Merchant, MerchantAccount } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigView } from '../accounts/accounts.js';
import { recoveryMessage, type SignerJson } from '../accounts/encoding.js';
import { eventLog } from '../accounts/events.js';
import { buildApp } from '../app.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { dashHeaders, loginAs, responseCookies, type Login } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb, setLiveMode } from '../test/helpers.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '@tendr/contracts';
import { onRecoveryPasskeyRegistered, onRecoverySessionOpened } from '../jobs/account-notices.js';
import { memoryMailer } from '../test/dashboard.js';
import { RECOVERY_LIMIT } from './recovery.js';

const HOUR = 3_600_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// Live writes here assume live mode is open (LIVE_MODE_ENABLED); the switch-off behaviour is
// tested in gateway/live-mode.test.ts.
beforeAll(() => setLiveMode(true));
afterAll(() => setLiveMode(undefined));

describe('recovery API', () => {
  let app: FastifyInstance;
  let fake: FakeNearClient;
  let merchant: Merchant;
  let account: MerchantAccount;
  let kit: { priv: Uint8Array; pub: Uint8Array };
  let config: ConfigView;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fake = fakeNearClient(true);
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant();
    account = (await createRow('MerchantAccount', merchant.id, true, {
      nearAccountId: `${merchant.slug}.tendr.near`,
      status: 'active',
      threshold: 1,
    })) as unknown as MerchantAccount;
    const priv = ed25519.utils.randomPrivateKey();
    kit = { priv, pub: ed25519.getPublicKey(priv) };
    await createRow('AccountKey', merchant.id, true, {
      nearAccountId: account.nearAccountId,
      publicKey: `ed25519:${b64(kit.pub)}`,
      kind: 'recovery',
    });
    config = {
      signers: [],
      threshold: 1,
      signer_epoch: '0',
      origins: ['http://localhost:3000'],
      rp_id: 'localhost',
      recovery_key_set: true,
      recovery_key_epoch: '3',
      intents_contract: 'intents.near',
      poa_suffix: 'omft.near',
    };
    fake.scriptView(account.nearAccountId, 'get_config', () => structuredClone(config));
    fake.scriptView(account.nearAccountId, 'list_saved_addresses', () => []);
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    resetNearClients();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const p256Key = () => ({
    p256: b64(Buffer.concat([Buffer.from([2]), randomBytes(32)])),
  });

  function signedBody(
    over: { newThreshold?: number; epoch?: bigint; nonce?: string; signers?: SignerJson[] } = {},
  ) {
    const newSigners: SignerJson[] = over.signers ?? [
      { id: `per_01${'J'.repeat(24)}`, keys: [p256Key()] },
    ];
    const nonce = over.nonce ?? '7';
    const validUntil = ns(Date.now() + 2 * HOUR);
    const message = recoveryMessage({
      contractId: account.nearAccountId,
      newSigners,
      newThreshold: 1,
      nonce: BigInt(nonce),
      recoveryKeyEpoch: over.epoch ?? 3n,
      validUntil: BigInt(validUntil),
    });
    return {
      merchant: merchant.slug,
      livemode: true,
      newSigners,
      newThreshold: over.newThreshold ?? 1,
      nonce,
      validUntil,
      signature: b64(ed25519.sign(message, kit.priv)),
    };
  }

  const start = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/account/recovery/start', payload });

  it('recovery_start_relays_signed_payload_unchanged', async () => {
    const body = signedBody();
    const recoveryId = 'ab'.repeat(32);
    fake.scriptLogs(account.nearAccountId, 'start_recovery', [
      eventLog('recovery_started', {
        recovery_id: recoveryId,
        nonce: '7',
        recovery_key_epoch: '3',
        new_signer_ids: body.newSigners.map((s) => s.id),
        new_threshold: 1,
        executes_at: ns(Date.now() + 72 * HOUR),
      }),
    ]);
    const res = await start(body);
    expect(res.statusCode, res.body).toBe(202);
    const calls = fake.callsTo('start_recovery');
    expect(calls).toHaveLength(1);
    expect((calls[0] as { args: object }).args).toEqual({
      new_signers: body.newSigners,
      new_threshold: body.newThreshold,
      nonce: body.nonce,
      valid_until: body.validUntil,
      signature: body.signature,
    });
    expect(res.json().recovery).toMatchObject({ status: 'pending', onchainId: recoveryId });
    expect(
      await prisma.event.count({
        where: { merchantId: merchant.id, type: 'account.recovery.started' },
      }),
    ).toBe(1);
  });

  it('a payload that does not verify is refused before any gas is spent', async () => {
    // Altered after signing.
    expect((await start({ ...signedBody(), newThreshold: 2 })).statusCode).toBe(400);
    // Signed for an old recovery-key epoch.
    expect((await start(signedBody({ epoch: 2n }))).statusCode).toBe(400);
    // Signed by another key.
    const other = ed25519.utils.randomPrivateKey();
    const body = signedBody();
    const forged = {
      ...body,
      signature: b64(
        ed25519.sign(
          recoveryMessage({
            contractId: account.nearAccountId,
            newSigners: body.newSigners,
            newThreshold: 1,
            nonce: 7n,
            recoveryKeyEpoch: 3n,
            validUntil: BigInt(body.validUntil),
          }),
          other,
        ),
      ),
    };
    expect((await start(forged)).statusCode).toBe(400);
    expect(fake.callsTo('start_recovery')).toHaveLength(0);
  });

  it('a contract rejection is a 409', async () => {
    fake.failNext('start_recovery', 'Smart contract panicked: recovery already pending');
    expect((await start(signedBody())).statusCode).toBe(409);
  });

  const startFrom = (payload: object, ip: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/account/recovery/start',
      payload,
      remoteAddress: ip,
    });

  it('is strictly rate limited per IP, for every request', async () => {
    for (let i = 0; i < RECOVERY_LIMIT; i++) {
      expect((await startFrom({ junk: true }, '10.9.9.9')).statusCode).toBe(400);
    }
    const res = await startFrom(signedBody(), '10.9.9.9');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it("unverified requests never use up the account's attempts (I2)", async () => {
    // Many bad signatures from many IPs, and requests for accounts that do not exist.
    for (let i = 0; i < RECOVERY_LIMIT + 3; i++) {
      expect(
        (await startFrom({ ...signedBody(), newThreshold: 2 }, `10.1.0.${i}`)).statusCode,
      ).toBe(400);
      expect(
        (await startFrom({ ...signedBody(), merchant: `nope-${i}` }, `10.2.0.${i}`)).statusCode,
      ).toBe(404);
    }
    fake.scriptLogs(account.nearAccountId, 'start_recovery', []);
    expect((await startFrom(signedBody(), '10.3.0.1')).statusCode).toBe(202);
    // Verified attempts do count per account.
    for (let i = 1; i < RECOVERY_LIMIT; i++) {
      fake.failNext('start_recovery', 'Smart contract panicked: recovery already pending');
      expect((await startFrom(signedBody(), `10.4.0.${i}`)).statusCode).toBe(409);
    }
    expect((await startFrom(signedBody(), '10.5.0.1')).statusCode).toBe(429);
  });

  it('verifies against the mirrored recovery-key epoch without reading the chain', async () => {
    await prisma.merchantAccount.update({
      where: { id: account.id },
      data: { recoveryKeyEpoch: 3n },
    });
    fake.scriptLogs(account.nearAccountId, 'start_recovery', []);
    expect((await start(signedBody())).statusCode).toBe(202);
    expect(fake.calls.filter((c) => c.kind === 'view' && c.method === 'get_config')).toHaveLength(
      0,
    );
  });

  async function signerMember(isSigner = true) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const auth = new SoftAuthenticator();
    const { credential } = await verifyRegistration(
      user,
      auth.create(await registrationOptions(user)),
      null,
    );
    await createRow('MerchantUser', merchant.id, false, {
      userId: user.id,
      role: 'owner',
      isSigner,
    });
    return { user, auth, credential, login: await loginAs(user.id) };
  }

  it('a signer cancels the pending recovery with a passkey; GET shows it', async () => {
    const s = await signerMember();
    const recoveryId = 'cd'.repeat(32);
    await createRow('RecoveryRequest', merchant.id, true, {
      onchainId: recoveryId,
      executesAt: new Date(Date.now() + 70 * HOUR),
      newSignerIds: ['per_x'],
    });
    fake.scriptView(account.nearAccountId, 'get_recovery', () => ({
      recovery_id: recoveryId,
      nonce: '7',
      recovery_key_epoch: '3',
      new_signer_ids: ['per_x'],
      new_threshold: 1,
      executes_at: ns(Date.now() + 70 * HOUR),
    }));
    fake.scriptLogs(account.nearAccountId, 'cancel_recovery', [
      eventLog('recovery_cancelled', { signer_id: s.user.id }),
    ]);
    const h = dashHeaders(s.login, { merchantId: merchant.id, livemode: true });
    const status = await app.inject({ method: 'GET', url: '/v1/account/recovery', headers: h });
    expect(status.json().recovery).toMatchObject({ status: 'pending', onchainId: recoveryId });

    const ch = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery/challenge',
      headers: h,
      payload: {},
    });
    expect(ch.statusCode, ch.body).toBe(200);
    expect(ch.json().recoveryId).toBe(recoveryId);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery/cancel',
      headers: h,
      payload: { response: s.auth.assert(ch.json().challengeB64u) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const call = fake.callsTo('cancel_recovery')[0] as {
      args: { approval: { signer_id: string } };
    };
    expect(call.args.approval.signer_id).toBe(s.user.id);
    expect(res.json().recovery).toMatchObject({ status: 'cancelled' });
  });

  it('recovery params come from the contract: account id, key epoch and last nonce', async () => {
    const m = await signerMember(false);
    fake.scriptView(account.nearAccountId, 'get_recovery_nonce', () => '41');
    const h = dashHeaders(m.login, { merchantId: merchant.id, livemode: true });
    const res = await app.inject({ method: 'GET', url: '/v1/account/recovery/params', headers: h });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      accountId: account.nearAccountId,
      livemode: true,
      recoveryKeySet: true,
      recoveryKeyEpoch: '3',
      lastNonce: '41',
    });
    // The payload the browser builds from them verifies (nonce = last + 1).
    const body = signedBody({ nonce: '42' });
    fake.scriptLogs(account.nearAccountId, 'start_recovery', []);
    expect((await start(body)).statusCode).toBe(202);
    // Signed out: no params.
    const anon = await app.inject({ method: 'GET', url: '/v1/account/recovery/params' });
    expect(anon.statusCode).toBe(401);
  });

  it('a non-signer cannot cancel a recovery', async () => {
    const m = await signerMember(false);
    const h = dashHeaders(m.login, { merchantId: merchant.id, livemode: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/recovery/challenge',
      headers: h,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  describe('lost all passkeys: the restricted recovery session (R28)', () => {
    /** A store member whose passkeys were all removed (revoked): the only recoverable person. */
    async function lostMember(isSigner = true) {
      const m = await signerMember(isSigner);
      await prisma.webauthnCredential.updateMany({
        where: { userId: m.user.id },
        data: { revokedAt: new Date() },
      });
      return m;
    }

    async function openSession(email: string, signWith = kit.priv, ip = '10.0.0.1') {
      const opt = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/options',
        payload: { merchant: merchant.slug, email },
        remoteAddress: ip,
      });
      expect(opt.statusCode, opt.body).toBe(200);
      const { challenge, message } = opt.json();
      expect(message).toBe(
        `tendr-recovery-session-v1:${account.nearAccountId}:${email.toLowerCase()}:${challenge}`,
      );
      const signature = b64(ed25519.sign(new TextEncoder().encode(message), signWith));
      const payload = { merchant: merchant.slug, email, challenge, signature };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/verify',
        payload,
        remoteAddress: ip,
      });
      return { res, payload };
    }

    function loginFrom(res: { headers: Record<string, unknown> }, userId: string): Login {
      const cookies = responseCookies(res.headers['set-cookie'] as string[]);
      return { token: cookies[SESSION_COOKIE]!, csrf: cookies[CSRF_COOKIE]!, userId };
    }

    /** The `recovery_register` token from the last mail to `to`. */
    function mailboxToken(to: string): string {
      const msg = [...memoryMailer().sent]
        .reverse()
        .find((m) => m.to === to && m.template === 'recovery_register_link');
      if (!msg) throw new Error(`no recovery_register_link mail to ${to}`);
      return new URL(msg.data.url!).searchParams.get('token')!;
    }

    async function runOutbox(type: string) {
      const events = await prisma.event.findMany({
        where: { type },
        orderBy: { createdAt: 'asc' },
      });
      for (const e of events) {
        if (type === 'account.recovery_session.opened') await onRecoverySessionOpened(e);
        else await onRecoveryPasskeyRegistered(e);
      }
      return events;
    }

    it('kit + mailbox register the first passkey; the person and every signer are told', async () => {
      const other = await signerMember(true);
      const m = await lostMember(false);
      const { res, payload } = await openSession(m.user.email);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        userId: m.user.id,
        merchantId: merchant.id,
        restricted: true,
      });
      const login = loginFrom(res, m.user.id);
      // R31: the session's CSRF value is in the body too, for a dashboard on another subdomain.
      expect(res.json().csrfToken).toBe(login.csrf);
      const session = await prisma.dashboardSession.findFirstOrThrow({
        where: { userId: m.user.id, recoveryMerchantId: merchant.id },
      });
      expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);

      // Opening it is announced to the person and to every current signer.
      const opened = await runOutbox('account.recovery_session.opened');
      expect(opened).toHaveLength(1);
      const told = (t: string) =>
        memoryMailer()
          .sent.filter((x) => x.template === t)
          .map((x) => x.to)
          .sort();
      expect(told('recovery_session_opened')).toEqual([m.user.email, other.user.email].sort());

      // Without the mailbox link: refused, at options and at verify.
      const h = dashHeaders(login);
      const noLink = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: h,
        payload: {},
      });
      expect(noLink.statusCode).toBe(403);
      const token = mailboxToken(m.user.email);
      const opts = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: h,
        payload: { recoveryToken: token },
      });
      expect(opts.statusCode, opts.body).toBe(200);
      const auth = new SoftAuthenticator();
      const created = auth.create(opts.json());
      const noLinkVerify = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/verify',
        headers: h,
        payload: { response: created },
      });
      expect(noLinkVerify.statusCode).toBe(403);
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/verify',
        headers: h,
        payload: { response: created, recoveryToken: token },
      });
      expect(reg.statusCode, reg.body).toBe(200);
      // M7: the notice was written with the credential (same transaction), naming it.
      const registered = await prisma.webauthnCredential.findFirstOrThrow({
        where: { userId: m.user.id, revokedAt: null },
      });
      const notices = await prisma.event.findMany({
        where: { type: 'account.recovery_session.passkey_registered' },
      });
      expect(notices.map((e) => e.payload)).toEqual([
        { userId: m.user.id, credentialId: registered.id },
      ]);
      await runOutbox('account.recovery_session.passkey_registered');
      expect(told('recovery_passkey_registered')).toEqual([m.user.email, other.user.email].sort());

      // The link is single use, and only a first passkey can be added this way.
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: h,
        payload: { recoveryToken: token },
      });
      expect(again.statusCode).toBe(403);

      // Everything else refuses the session.
      for (const [method, url, store] of [
        ['GET', '/v1/me', false],
        ['GET', '/v1/auth/passkeys', false],
        ['POST', '/v1/auth/passkeys/step-up/options', false],
        ['GET', '/v1/account', true],
        ['GET', '/v1/account/recovery', true],
        ['GET', '/v1/account/proposals', true],
        ['POST', '/v1/account/recovery/challenge', true],
      ] as const) {
        const r = await app.inject({
          method,
          url,
          headers: dashHeaders(login, store ? { merchantId: merchant.id, livemode: true } : {}),
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(r.statusCode, `${method} ${url}`).toBe(403);
      }

      // The challenge is single use.
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/verify',
        payload,
        remoteAddress: '10.0.0.9',
      });
      expect(replay.statusCode).toBe(401);
    });

    it('GET /v1/auth/recovery-session gives a fresh page its CSRF token, store and email only', async () => {
      const m = await lostMember(false);
      const { res } = await openSession(m.user.email);
      const login = loginFrom(res, m.user.id);
      // A fresh page load (the emailed link): only the session cookie, no CSRF cookie or memory.
      const cookieOnly = { cookie: `${SESSION_COOKIE}=${login.token}` };
      const info = await app.inject({
        method: 'GET',
        url: '/v1/auth/recovery-session',
        headers: cookieOnly,
      });
      expect(info.statusCode, info.body).toBe(200);
      expect(info.json()).toEqual({
        csrfToken: login.csrf,
        store: { id: merchant.id, slug: merchant.slug, name: merchant.name },
        email: m.user.email,
      });
      // The returned token alone (no CSRF cookie) lets the page register the passkey.
      const opts = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: { ...cookieOnly, 'tendr-csrf': info.json().csrfToken },
        payload: { recoveryToken: mailboxToken(m.user.email) },
      });
      expect(opts.statusCode, opts.body).toBe(200);
      // Other person routes stay closed to the restricted session.
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: cookieOnly });
      expect(me.statusCode).toBe(403);

      // An ordinary session has no recovery session; no session is UNAUTHENTICATED.
      const normal = await signerMember(true);
      const plain = await app.inject({
        method: 'GET',
        url: '/v1/auth/recovery-session',
        headers: dashHeaders(normal.login),
      });
      expect(plain.statusCode).toBe(404);
      const none = await app.inject({ method: 'GET', url: '/v1/auth/recovery-session' });
      expect(none.statusCode).toBe(401);
      expect(none.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('a member who still has an active passkey cannot be taken over with the kit', async () => {
      const m = await signerMember();
      expect((await openSession(m.user.email)).res.statusCode).toBe(401);
      expect(
        await prisma.dashboardSession.count({ where: { recoveryMerchantId: merchant.id } }),
      ).toBe(0);
      // Nor if they register one between options and verify (re-checked at verify).
      const lost = await lostMember();
      const opt = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/options',
        payload: { merchant: merchant.slug, email: lost.user.email },
      });
      await prisma.webauthnCredential.updateMany({
        where: { userId: lost.user.id },
        data: { revokedAt: null },
      });
      const { challenge, message } = opt.json();
      const late = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/verify',
        payload: {
          merchant: merchant.slug,
          email: lost.user.email,
          challenge,
          signature: b64(ed25519.sign(new TextEncoder().encode(message), kit.priv)),
        },
      });
      expect(late.statusCode).toBe(401);
    });

    it('a session whose person leaves the store stops working', async () => {
      const m = await lostMember(false);
      const { res } = await openSession(m.user.email);
      expect(res.statusCode).toBe(200);
      const login = loginFrom(res, m.user.id);
      const token = mailboxToken(m.user.email);
      await prisma.merchantUser.deleteMany({
        where: { merchantId: merchant.id, userId: m.user.id },
      });
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: dashHeaders(login),
        payload: { recoveryToken: token },
      });
      expect(r.statusCode).toBe(403);
    });

    it('a wrong kit, an expired challenge or a non-member email gets no session', async () => {
      const m = await lostMember();
      expect(
        (await openSession(m.user.email, ed25519.utils.randomPrivateKey(), '10.0.1.1')).res
          .statusCode,
      ).toBe(401);
      expect((await openSession('stranger@example.com', kit.priv, '10.0.1.2')).res.statusCode).toBe(
        401,
      );
      const opt = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/options',
        payload: { merchant: merchant.slug, email: m.user.email },
      });
      await prisma.webauthnChallenge.updateMany({
        where: { purpose: 'recovery_session' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const { challenge, message } = opt.json();
      const late = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/verify',
        payload: {
          merchant: merchant.slug,
          email: m.user.email,
          challenge,
          signature: b64(ed25519.sign(new TextEncoder().encode(message), kit.priv)),
        },
      });
      expect(late.statusCode).toBe(401);
      expect(
        await prisma.dashboardSession.count({ where: { recoveryMerchantId: { not: null } } }),
      ).toBe(0);
    });
  });
});
