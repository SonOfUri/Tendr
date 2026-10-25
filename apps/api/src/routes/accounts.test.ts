import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionMerchantAccount } from '../accounts/accounts.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createCredential, createRow, createUser, resetDb } from '../test/helpers.js';

describe('account routes', () => {
  let app: FastifyInstance;
  let test: FakeNearClient;
  let live: FakeNearClient;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let ownerLogin: Login;
  let merchantId: string;

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    test = fakeNearClient(false);
    live = fakeNearClient(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();

    const user = await createUser({ emailVerifiedAt: new Date() });
    await createCredential(user.id);
    ownerLogin = await loginAs(user.id);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchants',
      headers: dashHeaders(ownerLogin),
      payload: { name: 'Acme' },
    });
    expect(res.statusCode, res.body).toBe(201);
    // The store answers at once; the test account is provisioned by a job.
    expect(res.json().testAccount).toEqual({
      nearAccountId: 'acme.tendr.testnet',
      status: 'provisioning',
    });
    merchantId = res.json().id;
    expect(test.calls).toHaveLength(0);
    await provisionMerchantAccount(merchantId, false);
  });
  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    resetNearClients();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(role: MerchantUserRole, isSigner = false): Promise<Login> {
    const user = await createUser();
    await createCredential(user.id);
    await createRow('MerchantUser', merchantId, false, { userId: user.id, role, isSigner });
    return loginAs(user.id);
  }

  const h = (login: Login, livemode = false) => dashHeaders(login, { merchantId, livemode });
  const get = (url: string, login: Login, livemode = false) =>
    app.inject({ method: 'GET', url, headers: h(login, livemode) });
  const post = (url: string, login: Login, payload: object = {}, livemode = false) =>
    app.inject({ method: 'POST', url, headers: h(login, livemode), payload });

  it('GET /v1/account shows the mode account, its signers and threshold', async () => {
    const res = await get('/v1/account', ownerLogin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      livemode: false,
      account: {
        nearAccountId: 'acme.tendr.testnet',
        status: 'active',
        threshold: 1,
        signerEpoch: '0',
      },
      signers: [{ userId: ownerLogin.userId, keys: 1 }],
    });
  });

  it('test_principal_cannot_read_live_account', async () => {
    const second = await member('admin', true);
    void second;
    const go = await post('/v1/account/go-live', ownerLogin, { threshold: 1 });
    expect(go.statusCode, go.body).toBe(202);
    await provisionMerchantAccount(merchantId, true);
    live.scriptView('intents.near', 'mt_batch_balance_of', () => ['9']);
    test.scriptView('intents-mock.tendr.testnet', 'mt_batch_balance_of', () => ['1']);
    await prisma.settlementConfig.create({
      data: {
        id: `stc_${randomBytes(8).toString('hex')}`,
        merchantId,
        livemode: false,
        destAssetId: 'nep141:usdc.test',
        destChain: 'near',
        payoutMode: 'intents',
      },
    });

    const testView = await get('/v1/account', ownerLogin, false);
    expect(testView.json().account.nearAccountId).toBe('acme.tendr.testnet');
    expect(testView.body).not.toContain('acme.tendr.near');
    const testBalances = await get('/v1/account/balances', ownerLogin, false);
    expect(testBalances.statusCode, testBalances.body).toBe(200);
    expect(testBalances.json()).toMatchObject({ accountId: 'acme.tendr.testnet' });
    expect(testBalances.body).not.toContain('acme.tendr.near');
    expect(live.calls.filter((c) => c.kind === 'view')).toHaveLength(0);

    const liveView = await get('/v1/account', ownerLogin, true);
    expect(liveView.json().account.nearAccountId).toBe('acme.tendr.near');
  });

  it('go-live: check, owner only, step-up, the two-key rule', async () => {
    const check = await get('/v1/account/go-live', ownerLogin);
    expect(check.statusCode).toBe(200);
    // Only the checklist and the live account's status and id: no live internals.
    expect(check.json()).toEqual({
      checklist: { ok: false, missing: ['second_key'], signerCount: 1, recoveryKeySet: false },
      live: null,
    });

    const blocked = await post('/v1/account/go-live', ownerLogin);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details).toEqual({ missing: ['second_key'] });

    const admin = await member('admin', true);
    expect((await post('/v1/account/go-live', admin)).statusCode).toBe(403);

    const stale = await loginAs(ownerLogin.userId, { stepUp: false });
    expect((await post('/v1/account/go-live', stale)).statusCode).toBe(401);

    const tooHigh = await post('/v1/account/go-live', ownerLogin, { threshold: 3 });
    expect(tooHigh.statusCode).toBe(409);
    expect(tooHigh.json().error.details).toEqual({ missing: ['threshold'] });

    const ok = await post('/v1/account/go-live', ownerLogin, { threshold: 2 });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json()).toEqual({
      checklist: expect.objectContaining({ signerCount: 2 }),
      live: { nearAccountId: 'acme.tendr.near', status: 'provisioning' },
    });
    const again = await post('/v1/account/go-live', ownerLogin, { threshold: 1 });
    expect(again.statusCode).toBe(200);
    expect(again.json().live).toEqual({ nearAccountId: 'acme.tendr.near', status: 'provisioning' });
    expect(
      await prisma.merchantAccount.findFirst({ where: { merchantId, livemode: true } }),
    ).toMatchObject({ threshold: 2 });

    // A viewer in test mode reads the same trimmed checklist.
    const viewer = await member('viewer');
    const seen = await get('/v1/account/go-live', viewer);
    expect(seen.statusCode).toBe(200);
    expect(Object.keys(seen.json().live).sort()).toEqual(['nearAccountId', 'status']);
    expect(seen.body).not.toMatch(/threshold"?:\s*2|signerEpoch|createdTx/);
  });

  it('recovery key: owner only, with step-up; stored before go-live', async () => {
    const key = Buffer.from(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())).toString(
      'base64',
    );
    const admin = await member('admin', true);
    expect((await post('/v1/account/recovery-key', admin, { publicKey: key })).statusCode).toBe(
      403,
    );
    const stale = await loginAs(ownerLogin.userId, { stepUp: false });
    expect((await post('/v1/account/recovery-key', stale, { publicKey: key })).statusCode).toBe(
      401,
    );
    const res = await post('/v1/account/recovery-key', ownerLogin, { publicKey: key });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ stored: true });
    expect((await get('/v1/account/go-live', ownerLogin)).json().checklist).toMatchObject({
      ok: true,
      recoveryKeySet: true,
    });
  });

  it('a failed provisioning can be retried by the owner', async () => {
    await prisma.merchantAccount.updateMany({
      where: { merchantId, livemode: false },
      data: { status: 'failed' },
    });
    const res = await post('/v1/account/retry', ownerLogin);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ status: 'provisioning' });
  });
});
