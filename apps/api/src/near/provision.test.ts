import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../events/record.js';
import { LocalKeyVault } from '../keyvault/local.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, resetDb } from '../test/helpers.js';
import {
  RpcNearClient,
  fakeNearClient,
  nearClient,
  resetNearClients,
  type InitConfigJson,
  type ProvisionParams,
} from './client.js';
import { FakeNearClient } from './fake.js';
import { CappedNearClient, fundingSpentLast24h } from './provision.js';
import { NearRpc, NotBroadcastError } from './rpc.js';

beforeEach(resetDb);

const NEAR = 10n ** 24n;
const init: InitConfigJson = {
  signers: [{ id: 'per_01', keys: [{ ed25519: Buffer.alloc(32, 1).toString('base64') }] }],
  threshold: 1,
  recovery_key: null,
  rp_id: 'localhost',
  origins: ['http://localhost:3000'],
  intents_contract: 'intents-mock.tendr.testnet',
  poa_suffix: null,
  testnet_admin: 'tendr.testnet',
};

const scope = {
  livemode: false,
  parentAccountId: 'tendr.testnet',
  intentsContractId: 'intents-mock.tendr.testnet',
};

function setup(caps = { perAccountYocto: NEAR, dailyYocto: 3n * NEAR }) {
  const inner = new FakeNearClient(scope);
  return { inner, capped: new CappedNearClient(inner, scope, caps) };
}

const params = (merchantId: string, slug: string, amount: bigint): ProvisionParams => ({
  merchantId,
  livemode: false,
  accountId: `${slug}.tendr.testnet`,
  init,
  initialBalanceYocto: amount,
});

/** A prior `funding.spent` row, optionally back-dated. */
async function spent(merchantId: string, livemode: boolean, amount: bigint, createdAt?: Date) {
  const id = await prisma.$transaction((tx) =>
    recordEvent(
      tx,
      { merchantId, livemode },
      {
        aggregateType: 'near_account',
        aggregateId: 'old.tendr.testnet',
        type: 'funding.spent',
        payload: { accountId: 'old.tendr.testnet', amountYocto: amount.toString() },
      },
    ),
  );
  if (createdAt) {
    // events is append-only; back-date through the test-only replica bypass.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRaw`UPDATE events SET created_at = ${createdAt} WHERE id = ${id}`,
    ]);
  }
}

describe('CappedNearClient.provisionAccount', () => {
  it('provisions under both caps and records a funding.spent event on the merchant', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup();
    const res = await capped.provisionAccount(params(m.id, 'shop', NEAR / 2n));
    expect(res.status).toBe('success');
    expect(inner.accounts.has('shop.tendr.testnet')).toBe(true);
    const ev = await prisma.event.findFirstOrThrow({ where: { type: 'funding.spent' } });
    expect(ev).toMatchObject({
      merchantId: m.id,
      livemode: false,
      aggregateType: 'near_account',
      aggregateId: 'shop.tendr.testnet',
      payload: { accountId: 'shop.tendr.testnet', amountYocto: (NEAR / 2n).toString() },
    });
    expect(await fundingSpentLast24h(prisma, false)).toBe(NEAR / 2n);
  });

  it('provision_refuses_above_per_account_cap', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup();
    await expect(capped.provisionAccount(params(m.id, 'shop', NEAR + 1n))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { cap: 'per_account' },
    });
    expect(inner.calls).toHaveLength(0);
    expect(await prisma.event.count({ where: { type: 'funding.spent' } })).toBe(0);
  });

  it('validates the request before reserving any spend', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup();
    await expect(
      capped.provisionAccount({ ...params(m.id, 'shop', NEAR), accountId: 'shop.tendr.near' }),
    ).rejects.toThrow(/sub-account/);
    expect(inner.calls).toHaveLength(0);
    expect(await prisma.event.count({ where: { type: 'funding.spent' } })).toBe(0);
  });

  it('refuses a zero or negative balance', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup();
    await expect(capped.provisionAccount(params(m.id, 'shop', 0n))).rejects.toThrow(/positive/);
    expect(inner.calls).toHaveLength(0);
  });

  it('provision_refuses_when_daily_cap_exhausted', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup();
    await spent(m.id, false, 2n * NEAR + NEAR / 2n);
    await expect(capped.provisionAccount(params(m.id, 'shop', NEAR))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { cap: 'daily' },
    });
    expect(inner.calls).toHaveLength(0);
    // Exactly reaching the cap is allowed.
    expect((await capped.provisionAccount(params(m.id, 'shop', NEAR / 2n))).status).toBe('success');
  });

  it('counts only the last 24h and only the same mode', async () => {
    const m = await createMerchant();
    const { capped } = setup();
    await spent(m.id, false, 3n * NEAR, new Date(Date.now() - 25 * 3600_000));
    await spent(m.id, true, 3n * NEAR);
    expect(await fundingSpentLast24h(prisma, false)).toBe(0n);
    expect(await fundingSpentLast24h(prisma, true)).toBe(3n * NEAR);
    expect((await capped.provisionAccount(params(m.id, 'shop', NEAR))).status).toBe('success');
  });

  it('serialises concurrent provisionings so they cannot both pass the cap', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup({ perAccountYocto: NEAR, dailyYocto: NEAR });
    const results = await Promise.allSettled([
      capped.provisionAccount(params(m.id, 'a', NEAR)),
      capped.provisionAccount(params(m.id, 'b', NEAR)),
      capped.provisionAccount(params(m.id, 'c', NEAR)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(inner.accounts.size).toBe(1);
    expect(await prisma.event.count({ where: { type: 'funding.spent' } })).toBe(1);
  });

  it('nearClient(livemode) is the capped fake under NODE_ENV=test, separate per mode', async () => {
    resetNearClients();
    const m = await createMerchant();
    const res = await nearClient(false).provisionAccount(params(m.id, 'shop', NEAR / 10n));
    expect(res.status).toBe('success');
    expect(fakeNearClient(false).accounts.has('shop.tendr.testnet')).toBe(true);
    expect(fakeNearClient(true).accounts.size).toBe(0);
    expect(await prisma.event.count({ where: { type: 'funding.spent' } })).toBe(1);
    // The live client is scoped to the live parent and intents contract.
    await expect(
      nearClient(true).provisionAccount({ ...params(m.id, 'shop', 1n), livemode: true }),
    ).rejects.toThrow(/sub-account of tendr\.near/);
    resetNearClients();
  });

  it('delegates call, view and accessKeys to the inner client', async () => {
    const { inner, capped } = setup();
    inner.scriptView('a.tendr.testnet', 'v', () => 7);
    expect(await capped.view('a.tendr.testnet', 'v', {})).toBe(7);
    expect((await capped.call('relayer-accounts', 'a.tendr.testnet', 'm', {})).status).toBe(
      'success',
    );
    expect(inner.calls.map((c) => c.kind)).toEqual(['view', 'call']);
  });
});

describe('CappedNearClient reservation release', () => {
  const eventsOf = async (type: string) =>
    prisma.event.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });

  it('a preflight failure (config / key vault) reserves nothing', async () => {
    const m = await createMerchant();
    class KmsDown extends FakeNearClient {
      override async preflightProvision(): Promise<void> {
        throw new Error('KMS unavailable');
      }
    }
    const inner = new KmsDown(scope);
    const capped = new CappedNearClient(inner, scope, { perAccountYocto: NEAR, dailyYocto: NEAR });
    await expect(capped.provisionAccount(params(m.id, 'shop', NEAR))).rejects.toThrow(/KMS/);
    expect(await prisma.event.count()).toBe(0);
    expect(inner.calls).toHaveLength(0);
  });

  it('the real RPC client without a code hash fails preflight before reserving', async () => {
    const m = await createMerchant();
    const dir = mkdtempSync(join(tmpdir(), 'tendr-near-prov-'));
    try {
      const transport = { request: () => Promise.reject(new Error('no network in tests')) };
      const inner = new RpcNearClient({
        rpc: new NearRpc(transport),
        kv: new LocalKeyVault(join(dir, 'kv.json')),
        config: scope,
      });
      const capped = new CappedNearClient(inner, scope, {
        perAccountYocto: NEAR,
        dailyYocto: NEAR,
      });
      await expect(capped.provisionAccount(params(m.id, 'shop', NEAR))).rejects.toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
      expect(await prisma.event.count()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-broadcast failure leaves no net spend', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup({ perAccountYocto: NEAR, dailyYocto: NEAR });
    inner.throwNext('provision', new NotBroadcastError(new Error('RPC down')));
    await expect(capped.provisionAccount(params(m.id, 'shop', NEAR))).rejects.toBeInstanceOf(
      NotBroadcastError,
    );
    const [reservation] = await eventsOf('funding.spent');
    const [released] = await eventsOf('funding.released');
    expect(released).toMatchObject({
      merchantId: m.id,
      livemode: false,
      aggregateId: 'shop.tendr.testnet',
      payload: {
        amountYocto: NEAR.toString(),
        reservationId: reservation!.id,
        reason: 'not_broadcast',
      },
    });
    expect(await fundingSpentLast24h(prisma, false)).toBe(0n);
    // The full cap is available again: a retry succeeds.
    expect((await capped.provisionAccount(params(m.id, 'shop', NEAR))).status).toBe('success');
  });

  it('an on-chain batch failure releases the reservation', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup({ perAccountYocto: NEAR, dailyYocto: NEAR });
    inner.failNextProvision('Smart contract panicked: threshold');
    const res = await capped.provisionAccount(params(m.id, 'shop', NEAR));
    expect(res).toMatchObject({ status: 'failure', failure: expect.stringMatching(/threshold/) });
    expect(inner.accounts.size).toBe(0);
    const [released] = await eventsOf('funding.released');
    expect(released!.payload).toMatchObject({ reason: 'failed_on_chain', txHash: res.txHash });
    expect(await fundingSpentLast24h(prisma, false)).toBe(0n);
  });

  it('a timeout / unknown outcome keeps the reservation', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup({ perAccountYocto: NEAR, dailyYocto: NEAR });
    inner.throwNext('provision', Object.assign(new Error('Timeout'), { type: 'TimeoutError' }));
    await expect(capped.provisionAccount(params(m.id, 'shop', NEAR))).rejects.toThrow(/Timeout/);
    expect(await eventsOf('funding.released')).toHaveLength(0);
    expect(await fundingSpentLast24h(prisma, false)).toBe(NEAR);
    await expect(capped.provisionAccount(params(m.id, 'shop2', 1n))).rejects.toMatchObject({
      details: { cap: 'daily' },
    });
  });

  it('a release does not outlive its reservation in the 24 h window', async () => {
    const m = await createMerchant();
    const { inner, capped } = setup({ perAccountYocto: NEAR, dailyYocto: 3n * NEAR });
    inner.failNextProvision();
    await capped.provisionAccount(params(m.id, 'shop', NEAR));
    const [reservation] = await eventsOf('funding.spent');
    // Age the reservation out of the window; its (newer) release must not go negative.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRaw`UPDATE events SET created_at = now() - interval '25 hours' WHERE id = ${reservation!.id}`,
    ]);
    await spent(m.id, false, NEAR);
    expect(await fundingSpentLast24h(prisma, false)).toBe(NEAR);
  });
});
