import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../env.js';
import { buildApp } from '../app.js';
import { fakeNearClient, resetNearClients } from '../near/client.js';
import { createMerchant, createRow, createUser, resetDb, setLiveMode } from '../test/helpers.js';
import { dashHeaders, loginAs, memoryMailer } from '../test/dashboard.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { registrationOptions, verifyRegistration } from '../auth/webauthn.js';
import { onNativeWalletKeysChanged } from '../jobs/native-wallet-key-notices.js';
import {
  nativeActivationOptions,
  nativeAuthenticationOptions,
  nativeRegistrationOptions,
  registerNativeWallet,
  activateNativeWallet,
  ownedNativeWallet,
  verifyNativeAssertion,
  type NativeActor,
} from './native-accounts.js';
import {
  cancelNativeKeyOperation,
  getNativeKeyOperation,
  listNativeWalletKeys,
  nativeKeyOperationChallenge,
  processNativeKeyOperation,
  proveNativeCandidate,
  registerNativeCandidate,
  startNativeKeyOperation,
  submitNativeKeyOperation,
} from './native-key-operations.js';
import { setNativeKeyRelay, type NativeKeyRelay } from './native-key-relay.js';
import { payloadChallenge } from './native-signing.js';

class Chain implements NativeKeyRelay {
  keys = new Set<string>();
  nonces = new Set<string>();
  time = Date.now();
  unavailable = false;
  publish = vi.fn(async (_signed: object) => 'intent-hash');
  async salt() {
    return '12345678';
  }
  async state(_accountId: string, publicKeys: string[], nonce?: string) {
    if (this.unavailable) throw new Error('RPC unavailable');
    return {
      blockTimeMs: this.time,
      nonceUsed: !!nonce && this.nonces.has(nonce),
      keys: Object.fromEntries(publicKeys.map((k) => [k, this.keys.has(k)])),
    };
  }
  settle(signed: object) {
    const p = JSON.parse((signed as { payload: string }).payload) as {
      nonce: string;
      intents: { intent: string; public_key: string }[];
    };
    for (const i of p.intents)
      if (i.intent === 'add_public_key') this.keys.add(i.public_key);
      else if (i.intent === 'remove_public_key') this.keys.delete(i.public_key);
      else throw new Error('Unexpected funds-moving intent');
    this.nonces.add(p.nonce);
  }
}

describe('native wallet devices and offline recovery', () => {
  let actor: NativeActor;
  let original: SoftAuthenticator;
  let chain: Chain;
  beforeEach(async () => {
    await resetDb();
    resetNearClients();
    process.env.LIVE_ACCOUNT_DRIVER = 'native_intents';
    setLiveMode(true);
    const user = await createUser({ emailVerifiedAt: new Date() });
    const merchant = await createMerchant();
    actor = { merchantId: merchant.id, userId: user.id, livemode: true };
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role: 'owner' });
    original = new SoftAuthenticator();
    const options = await nativeRegistrationOptions(actor);
    await registerNativeWallet(actor, original.create(options));
    fakeNearClient(true).scriptView('intents.near', 'simulate_intents', () => ({
      intents_executed: [{}],
    }));
    const activation = await nativeActivationOptions(actor);
    await activateNativeWallet(actor, original.get(activation.options));
    chain = new Chain();
    chain.keys.add((await ownedNativeWallet(actor)).publicKey);
    setNativeKeyRelay(chain);
  });
  afterEach(() => {
    setNativeKeyRelay(null);
    resetNearClients();
    delete process.env.LIVE_ACCOUNT_DRIVER;
    setLiveMode(undefined);
    loadEnv();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newPasskey(
    kind: 'add_passkey' | 'recover' = 'add_passkey',
    recoveryKeyId?: string,
  ) {
    const auth = new SoftAuthenticator();
    const op = await startNativeKeyOperation(
      actor,
      kind === 'recover'
        ? { kind, label: 'Replacement laptop', recoveryKeyId: recoveryKeyId! }
        : { kind, label: 'Backup phone' },
    );
    const registration = await registerNativeCandidate(
      actor,
      op.id,
      auth.create(
        (op as { registrationOptions: PublicKeyCredentialCreationOptionsJSON }).registrationOptions,
      ),
    );
    await proveNativeCandidate(actor, op.id, {
      response: auth.get(
        (registration as { proofOptions: PublicKeyCredentialRequestOptionsJSON }).proofOptions,
      ),
    });
    return { auth, id: op.id };
  }
  async function approve(id: string, auth = original) {
    const c = await nativeKeyOperationChallenge(actor, id);
    await submitNativeKeyOperation(actor, id, {
      response: auth.get((c as { options: PublicKeyCredentialRequestOptionsJSON }).options),
    });
    return c;
  }
  async function settle(id: string) {
    const op = await prisma.nativeWalletKeyOperation.findUniqueOrThrow({ where: { id } });
    chain.settle(op.signature as object);
    await processNativeKeyOperation(id);
    expect((await getNativeKeyOperation(actor, id)).status).toBe('confirmed');
  }
  async function enableKit() {
    const seed = randomBytes(32);
    const op = await startNativeKeyOperation(actor, {
      kind: 'add_recovery',
      label: 'Offline kit',
      publicKeyB64: Buffer.from(ed25519.getPublicKey(seed)).toString('base64'),
      saved: true,
    });
    const proof = (op as { proofPayload: string }).proofPayload;
    await proveNativeCandidate(actor, op.id, {
      signatureB64: Buffer.from(ed25519.sign(Buffer.from(proof), seed)).toString('base64'),
    });
    await approve(op.id);
    await settle(op.id);
    const key = (await listNativeWalletKeys(actor)).keys.find(
      (k) => k.kind === 'recovery' && k.status === 'active',
    )!;
    return { seed, key };
  }

  it('requires possession and old-key approval; relay acceptance alone never grants access', async () => {
    const { auth, id } = await newPasskey();
    const wallet = await ownedNativeWallet(actor);
    const challenge = await nativeKeyOperationChallenge(actor, id);
    await expect(
      submitNativeKeyOperation(actor, id, {
        response: auth.assert(payloadChallenge(challenge.payload)),
      }),
    ).rejects.toThrow(/verified/);
    await expect(
      verifyNativeAssertion(wallet, 'payout', auth.assert(payloadChallenge('payout'))),
    ).rejects.toThrow(/verified/);
    const before = await nativeAuthenticationOptions(wallet, 'payout');
    expect(before.allowCredentials?.map((c) => c.id)).toEqual([original.id]);
    await approve(id);
    expect(chain.publish).toHaveBeenCalledTimes(1);
    expect(
      (await listNativeWalletKeys(actor)).keys.filter((k) => k.status === 'active'),
    ).toHaveLength(1);
    await settle(id);
    expect(
      (await nativeAuthenticationOptions(wallet, 'payout')).allowCredentials?.map((c) => c.id),
    ).toContain(auth.id);
    expect(
      (await verifyNativeAssertion(wallet, 'payout', auth.assert(payloadChallenge('payout'))))
        .signed.public_key,
    ).not.toBe(wallet.publicKey);
    expect((await ownedNativeWallet(actor)).account.nearAccountId).toBe(
      wallet.account.nearAccountId,
    );
    const event = await prisma.event.findFirstOrThrow({
      where: { type: 'native_wallet.keys_changed' },
    });
    await onNativeWalletKeysChanged(event);
    await onNativeWalletKeysChanged(event);
    expect(memoryMailer().sent.filter((m) => m.template === 'wallet_keys_changed')).toHaveLength(1);
  });

  it('recovers the same wallet and revokes original and backup passkeys atomically', async () => {
    const backup = await newPasskey();
    await approve(backup.id);
    await settle(backup.id);
    const { seed, key } = await enableKit();
    const before = await ownedNativeWallet(actor);
    const replacement = await newPasskey('recover', key.id);
    const c = await nativeKeyOperationChallenge(actor, replacement.id);
    expect(c.removedKeys).toHaveLength(2);
    expect(JSON.parse(c.payload).intents.map((i: { intent: string }) => i.intent)).toEqual([
      'add_public_key',
      'remove_public_key',
      'remove_public_key',
    ]);
    await expect(
      submitNativeKeyOperation(actor, replacement.id, {
        signatureB64: Buffer.from(ed25519.sign(Buffer.from(c.payload), randomBytes(32))).toString(
          'base64',
        ),
      }),
    ).rejects.toThrow(/verified/);
    await expect(
      submitNativeKeyOperation(actor, replacement.id, {
        response: original.assert(payloadChallenge(c.payload)),
      }),
    ).rejects.toThrow(/verified/);
    await submitNativeKeyOperation(actor, replacement.id, {
      signatureB64: Buffer.from(ed25519.sign(Buffer.from(c.payload), seed)).toString('base64'),
    });
    await settle(replacement.id);
    const after = await ownedNativeWallet(actor);
    expect(after.accountId).toBe(before.accountId);
    expect(after.account.nearAccountId).toBe(before.account.nearAccountId);
    for (const auth of [original, backup.auth])
      await expect(
        verifyNativeAssertion(after, 'payout', auth.assert(payloadChallenge('payout'))),
      ).rejects.toThrow(/verified/);
    await expect(
      verifyNativeAssertion(after, 'payout', replacement.auth.assert(payloadChallenge('payout'))),
    ).resolves.toHaveProperty('signed');
    expect(
      (await nativeAuthenticationOptions(after, 'payout')).allowCredentials?.map((k) => k.id),
    ).toEqual([replacement.auth.id]);
    const serialized = JSON.stringify(await listNativeWalletKeys(actor));
    expect(serialized).not.toContain(seed.toString('base64'));
    expect(await prisma.nativePayout.count()).toBe(0);
    seed.fill(0);
  });

  it('resends the identical signature after an unknown broadcast and confirms without a provider hash', async () => {
    const { id } = await newPasskey();
    chain.publish.mockImplementation(async () => {
      throw new Error('timeout after broadcast');
    });
    await approve(id);
    const first = chain.publish.mock.calls[0]![0];
    await prisma.nativeWalletKeyOperation.update({
      where: { id },
      data: { lastAttemptAt: new Date(0) },
    });
    await processNativeKeyOperation(id);
    expect(chain.publish.mock.calls[1]![0]).toEqual(first);
    chain.settle(first);
    await processNativeKeyOperation(id);
    const op = await getNativeKeyOperation(actor, id);
    expect(op.status).toBe('confirmed');
    expect(op.intentHash).toBeNull();
    expect(chain.publish).toHaveBeenCalledTimes(2);
  });

  it('uses final chain time for expiry and cannot cancel or replace an issued signing payload', async () => {
    const { id } = await newPasskey();
    await nativeKeyOperationChallenge(actor, id);
    await expect(cancelNativeKeyOperation(actor, id)).rejects.toThrow(/on-chain expiry/);
    await prisma.nativeWalletKeyOperation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    chain.time = Date.now() - 60_000;
    await processNativeKeyOperation(id);
    expect((await getNativeKeyOperation(actor, id)).status).toBe('awaiting_signature');
    await expect(
      startNativeKeyOperation(actor, { kind: 'add_passkey', label: 'Other' }),
    ).rejects.toThrow(/pending/);
    chain.unavailable = true;
    await processNativeKeyOperation(id);
    expect((await getNativeKeyOperation(actor, id)).status).toBe('awaiting_signature');
    chain.unavailable = false;
    chain.time = Date.now();
    await processNativeKeyOperation(id);
    expect((await getNativeKeyOperation(actor, id)).status).toBe('expired');
  });

  it('refuses grant when the consumed nonce and changed keys are not both confirmed', async () => {
    const { id } = await newPasskey();
    const c = await approve(id);
    chain.nonces.add(JSON.parse(c.payload).nonce);
    await processNativeKeyOperation(id);
    expect((await getNativeKeyOperation(actor, id)).status).toBe('submitting');
    expect(
      (await listNativeWalletKeys(actor)).keys.filter((k) => k.status === 'active'),
    ).toHaveLength(1);
  });

  it('protects the last passkey and requires a different key to authorize revocation', async () => {
    const first = (await listNativeWalletKeys(actor)).keys[0]!;
    await expect(
      startNativeKeyOperation(actor, { kind: 'revoke', keyId: first.id }),
    ).rejects.toThrow(/at least one/);
    const backup = await newPasskey();
    await approve(backup.id);
    await settle(backup.id);
    const op = await startNativeKeyOperation(actor, { kind: 'revoke', keyId: first.id });
    const c = await nativeKeyOperationChallenge(actor, op.id);
    expect(
      (c as { options: PublicKeyCredentialRequestOptionsJSON }).options.allowCredentials?.map(
        (k) => k.id,
      ),
    ).toEqual([backup.auth.id]);
    await expect(
      submitNativeKeyOperation(actor, op.id, {
        response: original.assert(payloadChallenge(c.payload)),
      }),
    ).rejects.toThrow(/verified/);
    await approve(op.id, backup.auth);
    await settle(op.id);
    expect((await listNativeWalletKeys(actor)).keys.find((k) => k.id === first.id)?.status).toBe(
      'revoked',
    );
  });

  it('rejects login credentials as wallet candidates and wallet candidates as login credentials', async () => {
    const auth = new SoftAuthenticator();
    await verifyRegistration(
      { id: actor.userId },
      auth.create(await registrationOptions({ id: actor.userId, email: 'owner@example.com' })),
      'login',
    );
    const op = await startNativeKeyOperation(actor, { kind: 'add_passkey', label: 'Bad reuse' });
    await expect(
      registerNativeCandidate(
        actor,
        op.id,
        auth.create(
          (op as { registrationOptions: PublicKeyCredentialCreationOptionsJSON })
            .registrationOptions,
        ),
      ),
    ).rejects.toThrow(/separate/);
    await cancelNativeKeyOperation(actor, op.id);
    const backup = await newPasskey();
    await expect(
      verifyRegistration(
        { id: actor.userId },
        backup.auth.create(
          await registrationOptions({ id: actor.userId, email: 'owner@example.com' }),
        ),
        'bad login',
      ),
    ).rejects.toThrow(/separate/);
  });

  it('rejects missing recovery, wrong owners, test mode, non-UV proofs, and parallel changes', async () => {
    await expect(
      startNativeKeyOperation(actor, { kind: 'recover', label: 'New', recoveryKeyId: 'missing' }),
    ).rejects.toThrow(/before losing/);
    const other = await createUser();
    await createRow('MerchantUser', actor.merchantId, false, { userId: other.id, role: 'owner' });
    await expect(listNativeWalletKeys({ ...actor, userId: other.id })).rejects.toThrow(
      /different owner/,
    );
    await expect(listNativeWalletKeys({ ...actor, livemode: false })).rejects.toThrow(/live mode/);
    const attempts = await Promise.allSettled([
      startNativeKeyOperation(actor, { kind: 'add_passkey', label: 'One' }),
      startNativeKeyOperation(actor, { kind: 'add_passkey', label: 'Two' }),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const op = attempts.find((a) => a.status === 'fulfilled')!;
    if (op.status !== 'fulfilled') throw new Error('missing operation');
    const auth = new SoftAuthenticator({ userVerified: false });
    await expect(
      registerNativeCandidate(
        actor,
        op.value.id,
        auth.create(
          (op.value as { registrationOptions: PublicKeyCredentialCreationOptionsJSON })
            .registrationOptions,
        ),
      ),
    ).rejects.toThrow(/verified/);
  });

  it('routes enforce recent login step-up, CSRF and a strict public-proof-only body', async () => {
    const app = await buildApp();
    await app.ready();
    try {
      const path = '/v1/account/native/keys/operations';
      const payload = { kind: 'add_passkey', label: 'Phone' };
      const login = await loginAs(actor.userId, { stepUp: false });
      const stale = await app.inject({
        method: 'POST',
        url: path,
        payload,
        headers: dashHeaders(login, actor),
      });
      expect(stale.statusCode).toBe(401);
      expect(stale.json().error.code).toBe('STEP_UP_REQUIRED');
      const fresh = await loginAs(actor.userId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload,
            headers: dashHeaders(fresh, { ...actor, csrf: null }),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path,
            payload: { ...payload, recoverySecret: 'never accepted' },
            headers: dashHeaders(fresh, actor),
          })
        ).statusCode,
      ).toBe(400);
      const created = await app.inject({
        method: 'POST',
        url: path,
        payload,
        headers: dashHeaders(fresh, actor),
      });
      expect(created.statusCode, created.body).toBe(201);
    } finally {
      await app.close();
    }
  });
});
