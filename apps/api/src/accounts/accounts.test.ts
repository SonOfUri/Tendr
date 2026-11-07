import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { Merchant, User, WebauthnCredential } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventHandler, handlerJobOptions } from '../jobs/handlers.js';
import '../jobs/register-handlers.js';
import { providerNotConfigured } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { FundingCapError, ProvisionRequestError } from '../near/provision.js';
import { NotBroadcastError } from '../near/rpc.js';
import { closeRedis, getRedis, whenReady } from '../lib/redis.js';
import { createStore, MAX_OWNED_STORES } from '../merchants/signup.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import type { FakeNearClient } from '../near/fake.js';
import { createCredential, createRow, createUser, resetDb, setLiveMode } from '../test/helpers.js';
import {
  balancesCacheKey,
  getBalances,
  goLive,
  goLiveCheck,
  mirrorTestSigners,
  provisionMerchantAccount,
  provisionTestAccount,
  ProvisioningInProgressError,
  PROVISION_HANDLER,
  PROVISION_JOB_OPTIONS,
  PROVISION_LEASE_MS,
  PROVISION_REQUESTED,
  registerRecoveryKey,
  retryProvisioning,
} from './accounts.js';

const ed25519Key = () =>
  Buffer.from(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())).toString('base64');

type Owner = { user: User; cred: WebauthnCredential; merchant: Merchant };

// Live writes here assume live mode is open (LIVE_MODE_ENABLED); the switch-off behaviour is
// tested in gateway/live-mode.test.ts.
beforeAll(() => setLiveMode(true));
afterAll(() => setLiveMode(undefined));

describe('merchant accounts', () => {
  let test: FakeNearClient;
  let live: FakeNearClient;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    test = fakeNearClient(false);
    live = fakeNearClient(true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    resetNearClients();
  });
  afterAll(async () => {
    await closeRedis();
    await prisma.$disconnect();
  });

  async function owner(name = 'Acme Coffee'): Promise<Owner> {
    const user = await createUser({ emailVerifiedAt: new Date() });
    const cred = await createCredential(user.id);
    const { merchant } = await createStore(user.id, name);
    return { user, cred, merchant };
  }

  /** Adds a member with one passkey; signer if asked. */
  async function addMember(
    merchantId: string,
    isSigner: boolean,
    role: 'admin' | 'finance' = 'admin',
  ) {
    const user = await createUser();
    const cred = await createCredential(user.id);
    await createRow('MerchantUser', merchantId, false, { userId: user.id, role, isSigner });
    return { user, cred };
  }

  /** Approves test-mode settlement (required by the go-live checklist). */
  async function setTestPayout(merchantId: string) {
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
  }

  const accountRow = (merchantId: string, livemode: boolean) =>
    prisma.merchantAccount.findFirst({ where: { merchantId, livemode } });

  describe('test account provisioning', () => {
    it('test_account_provisioned_after_first_passkey', async () => {
      const { user, cred, merchant } = await owner();
      // A revoked passkey is never put on chain.
      await createCredential(user.id, { revokedAt: new Date() });

      // Store creation queues the provisioning; nothing is on chain yet.
      const pending = await accountRow(merchant.id, false);
      expect(pending).toMatchObject({
        nearAccountId: 'acme-coffee.tendr.testnet',
        status: 'provisioning',
        threshold: 1,
      });
      const event = await prisma.event.findFirst({ where: { type: PROVISION_REQUESTED } });
      expect(event).toMatchObject({ merchantId: merchant.id, livemode: false });
      expect(await prisma.eventOutbox.count({ where: { eventId: event!.id } })).toBe(1);
      expect(test.calls).toHaveLength(0);

      // The worker's job does the provisioning.
      const handler = getEventHandler(PROVISION_REQUESTED, PROVISION_HANDLER);
      expect(handler).toBeDefined();
      await handler!(event!);

      const provisions = test.calls.filter((c) => c.kind === 'provision');
      expect(provisions).toHaveLength(1);
      expect(provisions[0]).toMatchObject({
        accountId: 'acme-coffee.tendr.testnet',
        init: {
          signers: [{ id: user.id, keys: [cred.publicKey] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents-mock.tendr.testnet',
          testnet_admin: 'tendr.testnet',
          poa_suffix: null,
        },
      });
      const active = await accountRow(merchant.id, false);
      expect(active).toMatchObject({ status: 'active', signerEpoch: 0n });
      expect(active!.createdTx).toBeTruthy();
      // The signer keys are mirrored for display.
      const keys = await prisma.accountKey.findMany({
        where: { merchantId: merchant.id, livemode: false },
      });
      expect(keys).toEqual([
        expect.objectContaining({
          kind: 'passkey',
          userId: user.id,
          credentialId: cred.id,
          nearAccountId: 'acme-coffee.tendr.testnet',
        }),
      ]);
      // A replayed job is a no-op.
      await handler!(event!);
      expect(test.calls.filter((c) => c.kind === 'provision')).toHaveLength(1);
      expect(live.calls).toHaveLength(0);
    });

    it('provisioning_failure_marks_account_failed_and_is_retryable', async () => {
      const { merchant } = await owner();
      test.failNextProvision();
      const failed = await provisionTestAccount(merchant.id);
      expect(failed.status).toBe('failed');
      expect(await prisma.event.count({ where: { type: 'funding.released' } })).toBe(1);

      const again = await retryProvisioning({ merchantId: merchant.id, livemode: false });
      expect(again.status).toBe('provisioning');
      expect(await prisma.event.count({ where: { type: PROVISION_REQUESTED } })).toBe(2);
      const ok = await provisionTestAccount(merchant.id);
      expect(ok.status).toBe('active');
      // An active account is not retried.
      await expect(
        retryProvisioning({ merchantId: merchant.id, livemode: false }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('an unknown outcome that did land is treated as success', async () => {
      const { merchant, user, cred } = await owner();
      const accountId = 'acme-coffee.tendr.testnet';
      test.throwNext('provision', new Error('timeout'));
      test.scriptAccessKeys(accountId, []);
      test.scriptView(accountId, 'get_config', () => ({
        signers: [{ id: user.id, keys: [cred.publicKey] }],
        threshold: 1,
        signer_epoch: '0',
        origins: ['http://localhost:3000'],
        rp_id: 'localhost',
        recovery_key_set: false,
        recovery_key_epoch: '0',
        intents_contract: 'intents-mock.tendr.testnet',
        poa_suffix: 'omft.near',
      }));
      const row = await provisionTestAccount(merchant.id);
      expect(row.status).toBe('active');
    });

    it('an unknown outcome that did not land marks the account failed and throws for a retry', async () => {
      const { merchant } = await owner();
      test.throwNext('provision', new Error('timeout'));
      await expect(provisionTestAccount(merchant.id)).rejects.toThrow(/timeout/);
      expect((await accountRow(merchant.id, false))!.status).toBe('failed');
      // The job retries (status failed is still provisionable) and succeeds.
      expect((await provisionTestAccount(merchant.id)).status).toBe('active');
    });

    it('a retry that finds the account already created checks it on chain', async () => {
      const { merchant, user, cred } = await owner();
      const accountId = 'acme-coffee.tendr.testnet';
      // The first attempt landed but we never learnt it.
      await test.provisionAccount({
        merchantId: merchant.id,
        livemode: false,
        accountId,
        initialBalanceYocto: 1n,
        init: {
          signers: [{ id: user.id, keys: [cred.publicKey as { p256: string }] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents-mock.tendr.testnet',
          poa_suffix: null,
          testnet_admin: 'tendr.testnet',
        },
      });
      expect((await provisionTestAccount(merchant.id)).status).toBe('active');
    });

    it('an existing account that carries access keys is not accepted', async () => {
      const { merchant } = await owner();
      const accountId = 'acme-coffee.tendr.testnet';
      test.failNextProvision(`account ${accountId} already exists`);
      test.scriptAccessKeys(accountId, ['ed25519:abc']);
      const row = await provisionTestAccount(merchant.id);
      expect(row.status).toBe('failed');
    });
  });

  describe('C-1: reserved labels and foreign accounts', () => {
    it("an existing account whose signers are not this store's is never adopted", async () => {
      const { merchant } = await owner();
      const accountId = 'acme-coffee.tendr.testnet';
      // Another Tendr-made account under this label (e.g. Tendr's own fee account): zero keys,
      // this mode's intents contract and RP ID, but signed by Tendr operators, not this store.
      const stranger = await createUser();
      const strangerCred = await createCredential(stranger.id);
      await test.provisionAccount({
        merchantId: 'mer_tendr',
        livemode: false,
        accountId,
        initialBalanceYocto: 1n,
        init: {
          signers: [{ id: stranger.id, keys: [strangerCred.publicKey as { p256: string }] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents-mock.tendr.testnet',
          poa_suffix: null,
          testnet_admin: 'tendr.testnet',
        },
      });
      test.failNextProvision(`account ${accountId} already exists`);
      const row = await provisionTestAccount(merchant.id);
      expect(row.status).toBe('failed');
      expect(await prisma.accountKey.count({ where: { merchantId: merchant.id } })).toBe(0);
      expect(
        await prisma.event.count({
          where: { type: 'merchant_account.activated', merchantId: merchant.id },
        }),
      ).toBe(0);
    });

    it('a store whose slug predates the reserved list cannot go live under that label', async () => {
      const { merchant, user } = await owner();
      // A store created before "fees" was reserved.
      await prisma.merchant.update({ where: { id: merchant.id }, data: { slug: 'fees' } });
      // Every write that names the live account label is refused.
      await expect(
        registerRecoveryKey({ merchantId: merchant.id, userId: user.id }, ed25519Key()),
      ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reserved/) });
      await addMember(merchant.id, true);
      await expect(
        goLive({ merchantId: merchant.id, userId: user.id }, { threshold: 2 }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await accountRow(merchant.id, true)).toBeNull();
    });
  });

  describe('store cap', () => {
    it('a person may own at most MAX_OWNED_STORES stores', async () => {
      expect(MAX_OWNED_STORES).toBe(5);
      const user = await createUser();
      await createCredential(user.id);
      for (let i = 0; i < MAX_OWNED_STORES; i++) await createStore(user.id, `Shop ${i}`);
      await expect(createStore(user.id, 'One more')).rejects.toMatchObject({ status: 409 });
      expect(await prisma.merchant.count()).toBe(MAX_OWNED_STORES);
    });
  });

  describe('go-live', () => {
    it('go_live_blocked_with_one_key', async () => {
      const { merchant, user } = await owner();
      expect(await goLiveCheck(merchant.id)).toEqual({
        ok: false,
        missing: ['second_key', 'payout'],
      });
      await expect(goLive({ merchantId: merchant.id, userId: user.id })).rejects.toMatchObject({
        status: 409,
        details: { missing: ['second_key', 'payout'] },
      });
      expect(await accountRow(merchant.id, true)).toBeNull();
    });

    it('go_live_allowed_with_passkey_plus_recovery', async () => {
      const { merchant, user } = await owner();
      await registerRecoveryKey({ merchantId: merchant.id, userId: user.id }, ed25519Key());
      await setTestPayout(merchant.id);
      expect(await goLiveCheck(merchant.id)).toEqual({ ok: true, missing: [] });
    });

    it('go_live_allowed_with_two_signers', async () => {
      const { merchant } = await owner();
      await addMember(merchant.id, true);
      // A non-signer does not count.
      await addMember(merchant.id, false);
      await setTestPayout(merchant.id);
      expect(await goLiveCheck(merchant.id)).toEqual({ ok: true, missing: [] });
      expect(await goLiveCheck(merchant.id, 2)).toEqual({ ok: true, missing: [] });
    });

    it('a signer without an active passkey does not count', async () => {
      const { merchant } = await owner();
      const { cred } = await addMember(merchant.id, true);
      await prisma.webauthnCredential.update({
        where: { id: cred.id },
        data: { revokedAt: new Date() },
      });
      expect(await goLiveCheck(merchant.id)).toEqual({
        ok: false,
        missing: ['second_key', 'payout'],
      });
    });

    it('go_live_rejects_threshold_above_signers', async () => {
      const { merchant, user } = await owner();
      await registerRecoveryKey({ merchantId: merchant.id, userId: user.id }, ed25519Key());
      await setTestPayout(merchant.id);
      // The recovery key never counts toward the threshold.
      expect(await goLiveCheck(merchant.id, 2)).toEqual({ ok: false, missing: ['threshold'] });
      expect(await goLiveCheck(merchant.id, 0)).toEqual({ ok: false, missing: ['threshold'] });
      await expect(
        goLive({ merchantId: merchant.id, userId: user.id }, { threshold: 2 }),
      ).rejects.toMatchObject({ status: 409, details: { missing: ['threshold'] } });
    });

    it('live_account_has_no_testnet_admin', async () => {
      const { merchant, user, cred } = await owner();
      const second = await addMember(merchant.id, true);
      const recovery = ed25519Key();
      await registerRecoveryKey({ merchantId: merchant.id, userId: user.id }, recovery);
      await setTestPayout(merchant.id);
      const created = await goLive({ merchantId: merchant.id, userId: user.id }, { threshold: 2 });
      expect(created).toMatchObject({
        nearAccountId: 'acme-coffee.tendr.near',
        livemode: true,
        status: 'provisioning',
        threshold: 2,
      });
      const row = await provisionMerchantAccount(merchant.id, true);
      expect(row.status).toBe('active');

      const [p] = live.calls.filter((c) => c.kind === 'provision');
      expect(p).toMatchObject({
        accountId: 'acme-coffee.tendr.near',
        init: {
          threshold: 2,
          recovery_key: recovery,
          testnet_admin: null,
          intents_contract: 'intents.near',
          rp_id: 'localhost',
        },
      });
      const init = (p as { init: { signers: { id: string; keys: unknown[] }[] } }).init;
      expect(init.signers).toEqual(
        expect.arrayContaining([
          { id: user.id, keys: [cred.publicKey] },
          { id: second.user.id, keys: [second.cred.publicKey] },
        ]),
      );
      // Nothing about the live account touched the test client.
      expect(test.calls.filter((c) => c.kind === 'provision')).toHaveLength(0);

      // Idempotent: a second go-live returns the existing account.
      const again = await goLive({ merchantId: merchant.id, userId: user.id }, { threshold: 1 });
      expect(again).toMatchObject({ id: created.id, threshold: 2, status: 'active' });
      expect(await prisma.merchantAccount.count({ where: { livemode: true } })).toBe(1);
    });
  });

  describe('recovery key', () => {
    it('rejects malformed keys and keys equal to a signer key', async () => {
      const { merchant, user } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      await expect(registerRecoveryKey(actor, 'not base64!')).rejects.toMatchObject({
        status: 400,
      });
      await expect(
        registerRecoveryKey(actor, randomBytes(31).toString('base64')),
      ).rejects.toMatchObject({ status: 400 });
      // url-safe base64 is not accepted (the contract wants standard base64).
      const urlSafe = Buffer.alloc(32, 0xfb).toString('base64url');
      await expect(registerRecoveryKey(actor, urlSafe)).rejects.toMatchObject({ status: 400 });

      const signerKey = ed25519Key();
      const second = await createUser();
      await createCredential(second.id, { publicKey: { ed25519: signerKey } });
      await createRow('MerchantUser', merchant.id, false, {
        userId: second.id,
        role: 'admin',
        isSigner: true,
      });
      await expect(registerRecoveryKey(actor, signerKey)).rejects.toMatchObject({ status: 400 });
    });

    it('before go-live it is stored and a new key replaces the old', async () => {
      const { merchant, user } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      const first = ed25519Key();
      const second = ed25519Key();
      expect(await registerRecoveryKey(actor, first)).toMatchObject({ stored: true });
      expect(await registerRecoveryKey(actor, second)).toMatchObject({ stored: true });
      const rows = await prisma.accountKey.findMany({
        where: { merchantId: merchant.id, kind: 'recovery' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.publicKey, r.revokedAt === null])).toEqual([
        [`ed25519:${first}`, false],
        [`ed25519:${second}`, true],
      ]);
      expect(rows[1]).toMatchObject({ livemode: true, nearAccountId: 'acme-coffee.tendr.near' });
    });

    it('after go-live it creates a rotate_recovery_key proposal instead', async () => {
      const { merchant, user } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      const original = ed25519Key();
      await registerRecoveryKey(actor, original);
      await setTestPayout(merchant.id);
      await goLive(actor);
      await provisionMerchantAccount(merchant.id, true);

      const next = ed25519Key();
      const res = await registerRecoveryKey(actor, next);
      expect(res).toMatchObject({
        stored: false,
        proposal: {
          kind: 'rotate_recovery_key',
          status: 'draft',
          action: { rotate_recovery_key: next },
        },
      });
      const active = await prisma.accountKey.findMany({
        where: { merchantId: merchant.id, kind: 'recovery', revokedAt: null },
      });
      expect(active.map((r) => r.publicKey)).toEqual([`ed25519:${original}`]);
    });

    it('rejects 32 bytes that are not a valid Ed25519 point', async () => {
      const { merchant, user } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      // The first small y with no x on the curve, and the identity (0, 1), which has small order.
      let notOnCurve = Buffer.alloc(32);
      for (let y = 2; ; y++) {
        notOnCurve = Buffer.alloc(32);
        notOnCurve[0] = y;
        try {
          ed25519.ExtendedPoint.fromHex(notOnCurve);
        } catch {
          break;
        }
      }
      const identity = Buffer.alloc(32);
      identity[0] = 1;
      expect(ed25519.ExtendedPoint.fromHex(identity).isSmallOrder()).toBe(true);
      for (const bad of [notOnCurve, identity]) {
        await expect(registerRecoveryKey(actor, bad.toString('base64'))).rejects.toMatchObject({
          status: 400,
        });
      }
    });

    it('is refused while a live account is provisioning or failed', async () => {
      const { merchant, user } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      await registerRecoveryKey(actor, ed25519Key());
      await setTestPayout(merchant.id);
      await goLive(actor);
      await expect(registerRecoveryKey(actor, ed25519Key())).rejects.toMatchObject({
        status: 409,
      });
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: true },
        data: { status: 'failed' },
      });
      await expect(registerRecoveryKey(actor, ed25519Key())).rejects.toMatchObject({
        status: 409,
      });
      expect(
        await prisma.accountKey.count({
          where: { merchantId: merchant.id, kind: 'recovery', revokedAt: null },
        }),
      ).toBe(1);
    });
  });

  describe('fix round 1', () => {
    it('a failed live attempt that later lands with other keys is reconciled from the chain', async () => {
      const { merchant, user, cred } = await owner();
      const actor = { merchantId: merchant.id, userId: user.id };
      const r1 = ed25519Key();
      await registerRecoveryKey(actor, r1);
      const second = await addMember(merchant.id, true);
      await setTestPayout(merchant.id);
      await goLive(actor, { threshold: 2 });
      const liveId = 'acme-coffee.tendr.near';

      // The provisioning times out and the tx has not executed yet: the row is marked failed.
      live.throwNext('provision', new Error('timeout'));
      await expect(provisionMerchantAccount(merchant.id, true)).rejects.toThrow(/timeout/);
      expect((await accountRow(merchant.id, true))!.status).toBe('failed');
      // The recovery key cannot be swapped under the in-flight attempt.
      await expect(registerRecoveryKey(actor, ed25519Key())).rejects.toMatchObject({
        status: 409,
      });

      // The timed-out tx lands — with only the owner as signer, threshold 1, no recovery key —
      // e.g. a set that differs from what Postgres now intends.
      await live.provisionAccount({
        merchantId: merchant.id,
        livemode: true,
        accountId: liveId,
        initialBalanceYocto: 1n,
        init: {
          signers: [{ id: user.id, keys: [cred.publicKey as { p256: string }] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents.near',
          poa_suffix: null,
          testnet_admin: null,
        },
      });

      // The retry hits "already exists" and activates from the chain's config.
      const row = await provisionMerchantAccount(merchant.id, true);
      expect(row).toMatchObject({ status: 'active', threshold: 1, signerEpoch: 0n });
      const keys = await prisma.accountKey.findMany({
        where: { merchantId: merchant.id, livemode: true, kind: 'passkey' },
      });
      expect(keys.map((k) => k.userId)).toEqual([user.id]);
      const mismatch = await prisma.event.findFirst({
        where: { type: 'merchant_account.provision_mismatch', merchantId: merchant.id },
      });
      expect(mismatch?.payload).toMatchObject({
        nearAccountId: liveId,
        recoveryKeySet: { intended: true, onChain: false },
        threshold: { intended: 2, onChain: 1 },
        signers: {
          intended: [user.id, second.user.id].sort(),
          onChain: [user.id],
        },
      });
      expect(
        await prisma.event.count({ where: { type: 'merchant_account.activated', livemode: true } }),
      ).toBe(1);
    });

    it('concurrent attempts: only the claimant provisions and activates', async () => {
      const { merchant } = await owner();
      const results = await Promise.allSettled([
        provisionTestAccount(merchant.id),
        provisionTestAccount(merchant.id),
      ]);
      // The winner activates; the loser either finds the row active or, while the winner still
      // holds its claim, throws a retryable ProvisioningInProgressError.
      const won = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'active');
      expect(won.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ProvisioningInProgressError);
        else expect(r.value.status).toBe('active');
      }
      expect(test.calls.filter((c) => c.kind === 'provision')).toHaveLength(1);
      expect(await prisma.event.count({ where: { type: 'merchant_account.activated' } })).toBe(1);
      // A late attempt on the active row changes nothing.
      await provisionTestAccount(merchant.id);
      expect(await prisma.event.count({ where: { type: 'merchant_account.activated' } })).toBe(1);
      const row = await accountRow(merchant.id, false);
      expect(row).toMatchObject({
        status: 'active',
        provisionAttemptId: null,
        provisionClaimedAt: null,
      });
    });

    it('a held claim blocks other attempts and the retry route; a stale one is taken over', async () => {
      const { merchant } = await owner();
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { status: 'failed', provisionAttemptId: 'other', provisionClaimedAt: new Date() },
      });
      await expect(provisionTestAccount(merchant.id)).rejects.toBeInstanceOf(
        ProvisioningInProgressError,
      );
      expect(test.calls).toHaveLength(0);
      await expect(
        retryProvisioning({ merchantId: merchant.id, livemode: false }),
      ).rejects.toMatchObject({ status: 409 });

      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { provisionClaimedAt: new Date(Date.now() - PROVISION_LEASE_MS - 1000) },
      });
      expect((await provisionTestAccount(merchant.id)).status).toBe('active');
    });

    it('a crashed attempt (claim held, never released) is recovered by the job after the lease', async () => {
      const { merchant } = await owner();
      const event = await prisma.event.findFirstOrThrow({ where: { type: PROVISION_REQUESTED } });
      const handler = getEventHandler(PROVISION_REQUESTED, PROVISION_HANDLER)!;
      // A worker claimed the row, then died before activating or marking it failed.
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { provisionAttemptId: 'dead', provisionClaimedAt: new Date() },
      });
      // BullMQ's stalled-job recovery re-runs the job within the lease: it must throw (retry),
      // not complete quietly.
      await expect(handler(event)).rejects.toBeInstanceOf(ProvisioningInProgressError);
      expect((await accountRow(merchant.id, false))!.status).toBe('provisioning');
      // The job's backoff outlasts the lease: 11 exponential retries from 1 s ≈ 34 min.
      expect(PROVISION_JOB_OPTIONS.attempts).toBe(12);
      const totalBackoffMs = (2 ** (PROVISION_JOB_OPTIONS.attempts - 1) - 1) * 1000;
      expect(totalBackoffMs).toBeGreaterThan(PROVISION_LEASE_MS);
      expect(handlerJobOptions(PROVISION_REQUESTED, PROVISION_HANDLER)).toEqual(
        PROVISION_JOB_OPTIONS,
      );
      // Once the lease has expired, the next retry claims the row and provisions it.
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { provisionClaimedAt: new Date(Date.now() - PROVISION_LEASE_MS - 1000) },
      });
      await handler(event);
      expect((await accountRow(merchant.id, false))!.status).toBe('active');
    });

    it('a crashed attempt is recoverable by the owner retry once the lease expires', async () => {
      const { merchant } = await owner();
      const ctx = { merchantId: merchant.id, livemode: false };
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { provisionAttemptId: 'dead', provisionClaimedAt: new Date() },
      });
      // Inside the lease the attempt may still be alive: no retry.
      await expect(retryProvisioning(ctx)).rejects.toMatchObject({ status: 409 });
      // A queued, never-claimed row is not retried either (its job is pending).
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: { provisionAttemptId: null, provisionClaimedAt: null },
      });
      await expect(retryProvisioning(ctx)).rejects.toMatchObject({ status: 409 });
      // Stuck in provisioning under an expired claim: the owner retry re-queues it.
      await prisma.merchantAccount.updateMany({
        where: { merchantId: merchant.id, livemode: false },
        data: {
          provisionAttemptId: 'dead',
          provisionClaimedAt: new Date(Date.now() - PROVISION_LEASE_MS - 1000),
        },
      });
      const requeued = await retryProvisioning(ctx);
      expect(requeued).toMatchObject({
        status: 'provisioning',
        provisionAttemptId: null,
        provisionClaimedAt: null,
      });
      expect(await prisma.event.count({ where: { type: PROVISION_REQUESTED } })).toBe(2);
      expect((await provisionTestAccount(merchant.id)).status).toBe('active');
    });

    it('a retry finds an account that already landed before spending (no funding cap in the way)', async () => {
      const { merchant, user, cred } = await owner();
      // The first attempt timed out but landed; its funding reservation is still held.
      await test.provisionAccount({
        merchantId: merchant.id,
        livemode: false,
        accountId: 'acme-coffee.tendr.testnet',
        initialBalanceYocto: 1n,
        init: {
          signers: [{ id: user.id, keys: [cred.publicKey as { p256: string }] }],
          threshold: 1,
          recovery_key: null,
          rp_id: 'localhost',
          origins: ['http://localhost:3000'],
          intents_contract: 'intents-mock.tendr.testnet',
          poa_suffix: null,
          testnet_admin: 'tendr.testnet',
        },
      });
      const before = test.calls.filter((c) => c.kind === 'provision').length;
      // Were the retry to provision again, the (full) daily cap would refuse it.
      test.throwNext('provision', new FundingCapError('daily', 'funding daily cap reached'));
      const row = await provisionTestAccount(merchant.id);
      expect(row.status).toBe('active');
      expect(test.calls.filter((c) => c.kind === 'provision')).toHaveLength(before);
      expect(await prisma.event.count({ where: { type: 'funding.spent' } })).toBe(0);
    });

    it('deterministic errors fail the row without a retry', async () => {
      const { merchant } = await owner();
      for (const err of [
        new FundingCapError('daily', 'funding daily cap reached'),
        new ProvisionRequestError('not a sub-account'),
        new NotBroadcastError(providerNotConfigured('MERCHANT_ACCOUNT_CODE_HASH_TEST is not set')),
      ]) {
        await prisma.merchantAccount.updateMany({
          where: { merchantId: merchant.id, livemode: false },
          data: { status: 'provisioning' },
        });
        test.throwNext('provision', err);
        // Resolves (no throw → no BullMQ retry) with the row failed.
        const row = await provisionTestAccount(merchant.id);
        expect(row.status).toBe('failed');
      }
      // A transient not-broadcast error still throws, so the job retries.
      test.throwNext('provision', new NotBroadcastError(new Error('kms unavailable')));
      await expect(provisionTestAccount(merchant.id)).rejects.toThrow(/kms unavailable/);
    });
  });

  describe('test mirror', () => {
    it('syncs the live signer set onto the test contract as the testnet admin', async () => {
      const { merchant, user } = await owner();
      await provisionTestAccount(merchant.id);
      const second = await addMember(merchant.id, true);
      await setTestPayout(merchant.id);
      await goLive({ merchantId: merchant.id, userId: user.id }, { threshold: 2 });
      await provisionMerchantAccount(merchant.id, true);

      await mirrorTestSigners(merchant.id);
      const syncs = test.callsTo('admin_sync_signers');
      expect(syncs).toHaveLength(1);
      expect(syncs[0]).toMatchObject({
        signer: 'funding-near',
        contractId: 'acme-coffee.tendr.testnet',
        args: { threshold: 2 },
      });
      const args = (syncs[0] as { args: { signers: { id: string }[] } }).args;
      expect(args.signers.map((s) => s.id).sort()).toEqual([user.id, second.user.id].sort());
      // The live client never makes an admin call.
      expect(live.calls.some((c) => c.kind === 'call')).toBe(false);
      // Already in sync: nothing to do.
      await mirrorTestSigners(merchant.id);
      expect(test.callsTo('admin_sync_signers')).toHaveLength(1);
    });

    it('does nothing before go-live', async () => {
      const { merchant } = await owner();
      await provisionTestAccount(merchant.id);
      await mirrorTestSigners(merchant.id);
      expect(test.callsTo('admin_sync_signers')).toHaveLength(0);
    });
  });

  describe('balances', () => {
    it('balances_cached_15s', async () => {
      const { merchant } = await owner();
      await provisionTestAccount(merchant.id);
      await whenReady(getRedis());
      await getRedis().del(balancesCacheKey(merchant.id, false));
      await createRow('SettlementConfig', merchant.id, false, { destAssetId: 'nep141:usdc.test' });
      await createRow('AccountProposal', merchant.id, false, {
        kind: 'withdraw',
        action: {
          withdraw: {
            asset: 'nep141:wrap.testnet',
            amount: '1',
            saved_address_id: 'x',
            route: { poa: { token_contract: 'a.omft.near' } },
          },
        },
      });
      test.scriptView('intents-mock.tendr.testnet', 'mt_batch_balance_of', (args) =>
        (args as { token_ids: string[] }).token_ids.map((t) =>
          t === 'nep141:usdc.test' ? '340282366920938463463374607431768211455' : '5',
        ),
      );

      const first = await getBalances(merchant.id, false);
      expect(first).toEqual({
        accountId: 'acme-coffee.tendr.testnet',
        balances: [
          { asset: 'nep141:usdc.test', amount: '340282366920938463463374607431768211455' },
          { asset: 'nep141:wrap.testnet', amount: '5' },
        ],
      });
      const views = () => test.calls.filter((c) => c.kind === 'view');
      expect(views()).toEqual([
        expect.objectContaining({
          contractId: 'intents-mock.tendr.testnet',
          method: 'mt_batch_balance_of',
          args: {
            account_id: 'acme-coffee.tendr.testnet',
            token_ids: ['nep141:usdc.test', 'nep141:wrap.testnet'],
          },
        }),
      ]);
      expect(await getBalances(merchant.id, false)).toEqual(first);
      expect(views()).toHaveLength(1);
      const ttl = await getRedis().ttl(balancesCacheKey(merchant.id, false));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(15);
      // After expiry the chain is read again.
      await getRedis().del(balancesCacheKey(merchant.id, false));
      await getBalances(merchant.id, false);
      expect(views()).toHaveLength(2);
      expect(live.calls).toHaveLength(0);
    });

    it('no account yet means no balances and no chain read', async () => {
      const { merchant } = await owner();
      expect(await getBalances(merchant.id, true)).toEqual({ accountId: null, balances: [] });
      expect(live.calls).toHaveLength(0);
    });
  });
});
