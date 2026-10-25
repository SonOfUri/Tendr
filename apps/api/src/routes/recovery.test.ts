import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { Merchant, MerchantAccount } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '@tendr/contracts';
import { RECOVERY_LIMIT } from './recovery.js';

const HOUR = 3_600_000;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

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

  it('is strictly rate limited per account', async () => {
    fake.failNext('start_recovery', 'x');
    for (let i = 0; i < RECOVERY_LIMIT; i++) {
      expect((await start({ ...signedBody(), newThreshold: 2 })).statusCode).toBe(400);
    }
    const res = await start(signedBody());
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
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

  describe('lost all passkeys: the restricted recovery session', () => {
    async function openSession(email: string, signWith = kit.priv) {
      const opt = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/options',
        payload: { merchant: merchant.slug, email },
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
      });
      return { res, payload };
    }

    function loginFrom(res: { headers: Record<string, unknown> }, userId: string): Login {
      const cookies = responseCookies(res.headers['set-cookie'] as string[]);
      return { token: cookies[SESSION_COOKIE]!, csrf: cookies[CSRF_COOKIE]!, userId };
    }

    it('the kit opens a session that may only register a passkey (and use public recovery)', async () => {
      const m = await signerMember();
      const { res, payload } = await openSession(m.user.email);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        userId: m.user.id,
        merchantId: merchant.id,
        restricted: true,
      });
      const login = loginFrom(res, m.user.id);
      const session = await prisma.dashboardSession.findFirstOrThrow({
        where: { userId: m.user.id, recoveryMerchantId: merchant.id },
      });
      expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);

      // Registers a new passkey without a step-up, although the person has a (lost) one.
      const auth = new SoftAuthenticator();
      const opts = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/options',
        headers: dashHeaders(login),
        payload: {},
      });
      expect(opts.statusCode, opts.body).toBe(200);
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/auth/passkeys/register/verify',
        headers: dashHeaders(login),
        payload: { response: auth.create(opts.json()) },
      });
      expect(reg.statusCode, reg.body).toBe(200);

      // Everything else refuses it.
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
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/recovery-session/verify',
        payload,
      });
      expect(again.statusCode).toBe(401);
    });

    it('a wrong kit, an expired challenge or a non-member email gets no session', async () => {
      const m = await signerMember();
      expect(
        (await openSession(m.user.email, ed25519.utils.randomPrivateKey())).res.statusCode,
      ).toBe(401);
      expect((await openSession('stranger@example.com')).res.statusCode).toBe(401);

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
