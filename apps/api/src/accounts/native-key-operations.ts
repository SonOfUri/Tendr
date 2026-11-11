import { randomBytes } from 'node:crypto';
import type {
  Prisma,
  NativeWallet,
  NativeWalletKey,
  NativeWalletKeyOperation,
} from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { z } from 'zod';
import { coseToSignerKey } from '../auth/webauthn.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { nativePublicKey } from './native-signing.js';
import { ownedNativeWallet, type NativeActor } from './native-accounts.js';
import { nativeKeyRelay } from './native-key-relay.js';
import {
  activeWalletPasskeys,
  ensureInitialWalletKey,
  keyAuthenticationOptions,
  recordWalletAssertion,
  verifyWalletKeyAssertion,
  walletKeyScope,
  reserveDedicatedWalletKey,
} from './native-wallet-keys.js';

const TTL = 10 * 60_000;
const SIGNING_TTL = 5 * 60_000;
const LEASE = 90_000;
const PENDING = ['registering', 'proving', 'awaiting_signature', 'submitting'];
const scope = (a: NativeActor) => ({ merchantId: a.merchantId, livemode: a.livemode });
const invalid = () =>
  new AppError('VALIDATION_ERROR', 'The wallet key proof could not be verified', 400);
const label = z.string().trim().min(1).max(80);
export const StartKeyOperation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_passkey'), label }).strict(),
  z
    .object({
      kind: z.literal('add_recovery'),
      label,
      publicKeyB64: z.string().max(64),
      saved: z.literal(true),
    })
    .strict(),
  z.object({ kind: z.literal('recover'), label, recoveryKeyId: z.string().max(128) }).strict(),
  z.object({ kind: z.literal('revoke'), keyId: z.string().max(128) }).strict(),
]);
type Start = z.infer<typeof StartKeyOperation>;
type Wallet = Awaited<ReturnType<typeof ownedNativeWallet>>;

export const keyView = (key: NativeWalletKey) => ({
  id: key.id,
  kind: key.kind,
  label: key.label,
  status: key.status,
  publicKey: key.publicKey,
  createdAt: key.createdAt,
  activatedAt: key.activatedAt,
  revokedAt: key.revokedAt,
});
const operationView = (op: NativeWalletKeyOperation) => ({
  id: op.id,
  kind: op.kind,
  label: op.label,
  status: op.status,
  candidateKeyId: op.candidateKeyId,
  recoveryKeyId: op.recoveryKeyId,
  revokeKeyIds: op.revokeKeyIds,
  expiresAt: op.expiresAt,
  intentHash: op.intentHash,
  confirmedAt: op.confirmedAt,
  createdAt: op.createdAt,
  canCancel: !op.payload && PENDING.includes(op.status),
});

async function lockWallet(tx: Prisma.TransactionClient, wallet: NativeWallet, userId?: string) {
  await tx.$queryRaw`SELECT id FROM native_wallets WHERE id = ${wallet.id} AND merchant_id = ${wallet.merchantId} AND livemode = ${wallet.livemode} FOR UPDATE`;
  if (userId) {
    await tx.$queryRaw`SELECT id FROM merchant_users WHERE merchant_id = ${wallet.merchantId} AND user_id = ${userId} FOR UPDATE`;
    if (
      wallet.ownerUserId !== userId ||
      !(await tx.merchantUser.findFirst({
        where: { merchantId: wallet.merchantId, userId, role: 'owner' },
      }))
    )
      throw forbidden('Only the wallet owner can manage its keys');
  }
}
async function operation(actor: NativeActor, wallet: NativeWallet, id: string) {
  const op = await prisma.nativeWalletKeyOperation.findFirst({
    where: { id, ...walletKeyScope(wallet), userId: actor.userId },
  });
  if (!op) throw notFound('Wallet key request not found');
  return op;
}
function assertOpen(op: NativeWalletKeyOperation, status: string) {
  if (op.status !== status || op.expiresAt <= new Date())
    throw conflict('This wallet key request has expired or changed; refresh the wallet');
}
async function candidate(wallet: NativeWallet, op: NativeWalletKeyOperation) {
  const key = await prisma.nativeWalletKey.findFirst({
    where: { id: op.candidateKeyId ?? '', ...walletKeyScope(wallet), status: 'pending' },
  });
  if (!key) throw conflict('This wallet key request no longer has a pending key');
  return key;
}
function decodeBase64(text: string, size: number) {
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== size || raw.toString('base64') !== text) throw invalid();
  return raw;
}
function recoveryPublicKey(value: string) {
  const bytes = decodeBase64(value, 32);
  try {
    const point = ed25519.ExtendedPoint.fromHex(bytes);
    if (point.isSmallOrder() || !point.isTorsionFree()) throw invalid();
  } catch {
    throw invalid();
  }
  return `ed25519:${bs58.encode(bytes)}`;
}
function verifyRecoverySignature(key: NativeWalletKey, payload: string, signatureB64: string) {
  try {
    if (
      key.kind !== 'recovery' ||
      !ed25519.verify(
        decodeBase64(signatureB64, 64),
        Buffer.from(payload),
        bs58.decode(key.publicKey.slice('ed25519:'.length)),
        { zip215: false },
      )
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}
const proofPayload = (
  wallet: Wallet,
  op: Pick<NativeWalletKeyOperation, 'id' | 'challenge'>,
  publicKey: string,
) =>
  JSON.stringify({
    purpose: 'tendr.wallet.key-possession.v1',
    operationId: op.id,
    accountId: wallet.account.nearAccountId,
    publicKey,
    challenge: op.challenge,
  });

export async function listNativeWalletKeys(actor: NativeActor) {
  const wallet = await ownedNativeWallet(actor);
  await ensureInitialWalletKey(wallet);
  const [keys, operations] = await Promise.all([
    prisma.nativeWalletKey.findMany({
      where: walletKeyScope(wallet),
      orderBy: { createdAt: 'asc' },
    }),
    prisma.nativeWalletKeyOperation.findMany({
      where: walletKeyScope(wallet),
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  return {
    accountId: wallet.account.nearAccountId,
    rpId: env().WEBAUTHN_RP_ID,
    contract: env().INTENTS_CONTRACT_LIVE,
    keys: keys.map(keyView),
    operations: operations.map(operationView),
  };
}

export async function startNativeKeyOperation(actor: NativeActor, input: Start) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  await ensureInitialWalletKey(wallet);
  const publicKey = input.kind === 'add_recovery' ? recoveryPublicKey(input.publicKeyB64) : null;
  const op = await tenantTransaction(actor, async (tx) => {
    await lockWallet(tx, wallet, actor.userId);
    // Only requests which never issued a chain-signable payload can expire by local time.
    await tx.nativeWalletKeyOperation.updateMany({
      where: {
        ...walletKeyScope(wallet),
        status: { in: PENDING },
        payload: null,
        expiresAt: { lte: new Date() },
      },
      data: { status: 'expired' },
    });
    if (
      await tx.nativeWalletKeyOperation.findFirst({
        where: { ...walletKeyScope(wallet), status: { in: PENDING } },
      })
    )
      throw conflict('Finish the pending wallet key request first, or wait for it to expire');
    const keys = await tx.nativeWalletKey.findMany({
      where: { ...walletKeyScope(wallet), status: 'active' },
    });
    const revokeKeyIds: string[] = [];
    if (input.kind === 'recover') {
      if (!keys.some((k) => k.id === input.recoveryKeyId && k.kind === 'recovery'))
        throw conflict(
          'A wallet recovery kit must have been enabled before losing your wallet passkey',
        );
      revokeKeyIds.push(...keys.filter((k) => k.kind === 'passkey').map((k) => k.id));
    } else if (input.kind === 'revoke') {
      const target = keys.find((k) => k.id === input.keyId);
      if (!target) throw notFound('Active wallet key not found');
      if (!keys.some((k) => k.kind === 'passkey' && k.id !== target.id))
        throw conflict('Keep at least one other wallet passkey before removing this key');
      revokeKeyIds.push(target.id);
    } else if (input.kind === 'add_recovery') {
      // Replacing a kit adds its successor and revokes the previous kit atomically.
      revokeKeyIds.push(...keys.filter((k) => k.kind === 'recovery').map((k) => k.id));
    }
    if (keys.length - revokeKeyIds.length >= 16)
      throw conflict('Remove an unused wallet key before adding another');
    if (publicKey && input.kind === 'add_recovery')
      await reserveDedicatedWalletKey(tx, null, publicKey, { ed25519: input.publicKeyB64 });
    const id = newId('nko');
    const challenge = randomBytes(32).toString('base64url');
    const key = publicKey
      ? await tx.nativeWalletKey.create({
          data: {
            id: newId('nwk'),
            ...walletKeyScope(wallet),
            kind: 'recovery',
            label: input.kind === 'add_recovery' ? input.label : '',
            publicKey,
            transports: [],
          },
        })
      : null;
    const created = await tx.nativeWalletKeyOperation.create({
      data: {
        id,
        ...walletKeyScope(wallet),
        userId: actor.userId,
        kind: input.kind,
        label:
          input.kind === 'revoke' ? keys.find((k) => k.id === input.keyId)!.label : input.label,
        status: input.kind === 'revoke' ? 'awaiting_signature' : key ? 'proving' : 'registering',
        candidateKeyId: key?.id,
        recoveryKeyId: input.kind === 'recover' ? input.recoveryKeyId : null,
        revokeKeyIds,
        challenge,
        proofPayload: key ? proofPayload(wallet, { id, challenge }, key.publicKey) : '',
        expiresAt: new Date(Date.now() + TTL),
      },
    });
    return created;
  });
  return operationResponse(wallet, op);
}

async function operationResponse(wallet: Wallet, op: NativeWalletKeyOperation) {
  if (op.status === 'registering')
    return {
      ...operationView(op),
      registrationOptions: await generateRegistrationOptions({
        rpID: env().WEBAUTHN_RP_ID,
        rpName: env().WEBAUTHN_RP_NAME,
        challenge: Buffer.from(op.challenge, 'base64url'),
        userID: new TextEncoder().encode(op.id),
        userName: `${op.label} — Tendr wallet`,
        userDisplayName: op.label,
        supportedAlgorithmIDs: [-7],
        attestationType: 'none',
        excludeCredentials: [],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      }),
    };
  if (op.status === 'proving') {
    const key = await candidate(wallet, op);
    return {
      ...operationView(op),
      proofPayload: op.proofPayload,
      candidate: keyView(key),
      ...(key.kind === 'passkey'
        ? { proofOptions: await keyAuthenticationOptions([key], op.proofPayload) }
        : {}),
    };
  }
  return operationView(op);
}

export async function getNativeKeyOperation(actor: NativeActor, id: string) {
  const wallet = await ownedNativeWallet(actor);
  return operationResponse(wallet, await operation(actor, wallet, id));
}

export async function registerNativeCandidate(
  actor: NativeActor,
  id: string,
  response: RegistrationResponseJSON,
) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const op = await operation(actor, wallet, id);
  assertOpen(op, 'registering');
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: op.challenge,
      expectedOrigin: env().WEBAUTHN_ORIGINS,
      expectedRPID: env().WEBAUTHN_RP_ID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7],
    });
  } catch {
    throw invalid();
  }
  if (!result.verified || !result.registrationInfo.userVerified) throw invalid();
  const credential = result.registrationInfo.credential;
  const signer = coseToSignerKey(credential.publicKey);
  if (!('p256' in signer)) throw invalid();
  const publicKey = nativePublicKey(signer.p256);
  const changed = await tenantTransaction(actor, async (tx) => {
    await lockWallet(tx, wallet, actor.userId);
    await reserveDedicatedWalletKey(tx, credential.id, publicKey, signer);
    // The legacy table also reserves keys registered by an old process during rollout.
    if (
      await tx.nativeWallet.findFirst({
        where: { OR: [{ credentialId: credential.id }, { publicKey }] },
      })
    )
      throw conflict('This wallet passkey is already in use');
    const key = await tx.nativeWalletKey.create({
      data: {
        id: newId('nwk'),
        ...walletKeyScope(wallet),
        kind: 'passkey',
        label: op.label,
        publicKey,
        credentialId: credential.id,
        cosePublicKey: Buffer.from(credential.publicKey).toString('base64'),
        signCount: BigInt(credential.counter),
        transports: credential.transports ?? [],
      },
    });
    const used = await tx.nativeWalletKeyOperation.updateMany({
      where: {
        id,
        ...walletKeyScope(wallet),
        status: 'registering',
        expiresAt: { gt: new Date() },
      },
      data: {
        candidateKeyId: key.id,
        proofPayload: proofPayload(wallet, op, publicKey),
        status: 'proving',
      },
    });
    if (used.count !== 1) throw conflict('The registration request changed; refresh the wallet');
    return tx.nativeWalletKeyOperation.findUniqueOrThrow({ where: { id } });
  });
  return operationResponse(wallet, changed);
}

export async function proveNativeCandidate(
  actor: NativeActor,
  id: string,
  proof: { response?: AuthenticationResponseJSON; signatureB64?: string },
) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const op = await operation(actor, wallet, id);
  assertOpen(op, 'proving');
  const key = await candidate(wallet, op);
  let counter = 0n;
  if (key.kind === 'passkey') {
    if (!proof.response) throw invalid();
    counter = (await verifyWalletKeyAssertion(key, op.proofPayload, proof.response)).counter;
  } else {
    if (!proof.signatureB64) throw invalid();
    verifyRecoverySignature(key, op.proofPayload, proof.signatureB64);
  }
  await tenantTransaction(actor, async (tx) => {
    await lockWallet(tx, wallet, actor.userId);
    const used = await tx.nativeWalletKeyOperation.updateMany({
      where: { id, ...walletKeyScope(wallet), status: 'proving', expiresAt: { gt: new Date() } },
      data: { status: 'awaiting_signature' },
    });
    if (used.count !== 1) throw conflict('This key proof has already been used');
    await tx.nativeWalletKey.updateMany({
      where: { id: key.id, ...walletKeyScope(wallet), status: 'pending' },
      data: { signCount: counter },
    });
  });
  return getNativeKeyOperation(actor, id);
}

/** The payload is issued once. Never replace a nonce after a signature could have escaped. */
export async function nativeKeyOperationChallenge(actor: NativeActor, id: string) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  let op = await operation(actor, wallet, id);
  assertOpen(op, 'awaiting_signature');
  if (!op.payload) {
    const salt = await nativeKeyRelay().salt();
    if (!/^[0-9a-f]{8}$/.test(salt)) throw new Error('Invalid nonce salt');
    op = await tenantTransaction(actor, async (tx) => {
      await lockWallet(tx, wallet, actor.userId);
      const current = await tx.nativeWalletKeyOperation.findFirstOrThrow({
        where: { id, ...walletKeyScope(wallet) },
      });
      assertOpen(current, 'awaiting_signature');
      if (current.payload) return current;
      const keys = await tx.nativeWalletKey.findMany({ where: walletKeyScope(wallet) });
      const added = current.candidateKeyId
        ? keys.find((k) => k.id === current.candidateKeyId && k.status === 'pending')
        : null;
      if (current.candidateKeyId && !added) throw conflict('The new key is unavailable');
      const removed = current.revokeKeyIds.map((keyId) =>
        keys.find((k) => k.id === keyId && k.status === 'active'),
      );
      if (removed.some((k) => !k)) throw conflict('The wallet keys changed; refresh the wallet');
      const expiresAt = new Date(Math.min(current.expiresAt.getTime(), Date.now() + SIGNING_TTL));
      const payload = JSON.stringify({
        signer_id: wallet.account.nearAccountId,
        verifying_contract: env().INTENTS_CONTRACT_LIVE,
        deadline: expiresAt.toISOString(),
        nonce: Buffer.concat([Buffer.from(salt, 'hex'), randomBytes(28)]).toString('base64'),
        intents: [
          ...(added ? [{ intent: 'add_public_key', public_key: added.publicKey }] : []),
          ...removed.map((k) => ({ intent: 'remove_public_key', public_key: k!.publicKey })),
        ],
      });
      return tx.nativeWalletKeyOperation.update({ where: { id }, data: { payload, expiresAt } });
    });
  }
  const keys = await prisma.nativeWalletKey.findMany({ where: walletKeyScope(wallet) });
  return {
    ...operationView(op),
    accountId: wallet.account.nearAccountId,
    contract: env().INTENTS_CONTRACT_LIVE,
    payload: op.payload!,
    addedKey: keys.find((k) => k.id === op.candidateKeyId)
      ? keyView(keys.find((k) => k.id === op.candidateKeyId)!)
      : null,
    removedKeys: keys.filter((k) => op.revokeKeyIds.includes(k.id)).map(keyView),
    ...(op.kind === 'recover'
      ? { recoveryKey: keyView(keys.find((k) => k.id === op.recoveryKeyId)!) }
      : {
          options: await keyAuthenticationOptions(
            await activeWalletPasskeys(wallet, op.revokeKeyIds),
            op.payload!,
          ),
        }),
  };
}

export async function submitNativeKeyOperation(
  actor: NativeActor,
  id: string,
  proof: { response?: AuthenticationResponseJSON; signatureB64?: string },
) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const op = await operation(actor, wallet, id);
  if (op.status === 'submitting' || op.status === 'confirmed') return operationView(op);
  assertOpen(op, 'awaiting_signature');
  if (!op.payload) throw conflict('Review this wallet key change before signing');
  let signed: object;
  let signerId: string;
  let counter: bigint | null = null;
  if (op.kind === 'recover') {
    const key = await prisma.nativeWalletKey.findFirst({
      where: {
        id: op.recoveryKeyId ?? '',
        ...walletKeyScope(wallet),
        kind: 'recovery',
        status: 'active',
      },
    });
    if (!key || !proof.signatureB64 || proof.response) throw invalid();
    verifyRecoverySignature(key, op.payload, proof.signatureB64);
    signerId = key.id;
    signed = {
      standard: 'raw_ed25519',
      payload: op.payload,
      public_key: key.publicKey,
      signature: `ed25519:${bs58.encode(decodeBase64(proof.signatureB64, 64))}`,
    };
  } else {
    const key = (await activeWalletPasskeys(wallet, op.revokeKeyIds)).find(
      (k) => k.credentialId === proof.response?.id,
    );
    if (!key || !proof.response || proof.signatureB64) throw invalid();
    const verified = await verifyWalletKeyAssertion(key, op.payload, proof.response);
    signed = verified.signed;
    signerId = key.id;
    counter = verified.counter;
  }
  await tenantTransaction(actor, async (tx) => {
    await lockWallet(tx, wallet, actor.userId);
    if (counter !== null) await recordWalletAssertion(tx, wallet, signerId, counter);
    else if (
      !(await tx.nativeWalletKey.findFirst({
        where: { id: signerId, ...walletKeyScope(wallet), status: 'active' },
      }))
    )
      throw invalid();
    const changed = await tx.nativeWalletKeyOperation.updateMany({
      where: {
        id,
        ...walletKeyScope(wallet),
        status: 'awaiting_signature',
        payload: op.payload,
        expiresAt: { gt: new Date() },
      },
      data: { status: 'submitting', signature: signed as Prisma.InputJsonValue },
    });
    if (changed.count !== 1) throw conflict('This wallet key change has already been submitted');
  });
  // Every retry uses exactly these durable signed bytes. Provider acceptance is NOT activation.
  await processNativeKeyOperation(id);
  return operationView(await operation(actor, wallet, id));
}

export async function cancelNativeKeyOperation(actor: NativeActor, id: string) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor);
  const op = await operation(actor, wallet, id);
  if (op.payload)
    throw conflict(
      'This request issued a signing payload; wait for on-chain expiry before starting another',
    );
  await tenantTransaction(actor, async (tx) => {
    await lockWallet(tx, wallet, actor.userId);
    const changed = await tx.nativeWalletKeyOperation.updateMany({
      where: { id, ...walletKeyScope(wallet), payload: null, status: { in: PENDING } },
      data: { status: 'cancelled' },
    });
    if (changed.count !== 1) throw conflict('This request can no longer be cancelled');
  });
  return operationView(await operation(actor, wallet, id));
}

export async function processNativeKeyOperation(id: string) {
  const now = new Date();
  const claim = await prisma.nativeWalletKeyOperation.updateMany({
    where: {
      id,
      status: { in: PENDING },
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - LEASE) } }],
    },
    data: { claimedAt: now },
  });
  if (claim.count !== 1) return;
  try {
    const op = await prisma.nativeWalletKeyOperation.findUniqueOrThrow({ where: { id } });
    const wallet = await prisma.nativeWallet.findFirstOrThrow({
      where: { id: op.walletId, ...scope(op) },
      include: { account: true },
    });
    const finishExpired = () =>
      prisma.nativeWalletKeyOperation.updateMany({
        where: { id, claimedAt: now, status: { in: PENDING } },
        data: { status: 'expired' },
      });
    if (!op.payload) {
      if (op.expiresAt <= new Date()) await finishExpired();
      return;
    }
    const keys = await prisma.nativeWalletKey.findMany({ where: walletKeyScope(wallet) });
    const affected = keys.filter(
      (k) => k.id === op.candidateKeyId || op.revokeKeyIds.includes(k.id),
    );
    const nonce = (JSON.parse(op.payload) as { nonce: string }).nonce;
    const state = await nativeKeyRelay().state(
      wallet.account.nearAccountId,
      affected.map((k) => k.publicKey),
      nonce,
    );
    if (state.nonceUsed) {
      // Same final block must contain both nonce consumption AND exactly the requested keys.
      if (
        affected.length !== op.revokeKeyIds.length + (op.candidateKeyId ? 1 : 0) ||
        affected.some((k) => state.keys[k.publicKey] !== (k.id === op.candidateKeyId))
      )
        return;
      await tenantTransaction(op, async (tx) => {
        await lockWallet(tx, wallet);
        const changed = await tx.nativeWalletKeyOperation.updateMany({
          where: { id, ...walletKeyScope(wallet), claimedAt: now, status: { in: PENDING } },
          data: { status: 'confirmed', confirmedAt: new Date() },
        });
        if (changed.count !== 1) return;
        if (op.candidateKeyId)
          await tx.nativeWalletKey.updateMany({
            where: { id: op.candidateKeyId, ...walletKeyScope(wallet), status: 'pending' },
            data: { status: 'active', activatedAt: new Date() },
          });
        await tx.nativeWalletKey.updateMany({
          where: { id: { in: op.revokeKeyIds }, ...walletKeyScope(wallet), status: 'active' },
          data: { status: 'revoked', revokedAt: new Date() },
        });
        await recordEvent(tx, op, {
          aggregateType: 'native_wallet',
          aggregateId: wallet.id,
          type: 'native_wallet.keys_changed',
          payload: {
            operationId: op.id,
            kind: op.kind,
            ownerUserId: op.userId,
            addedKeyId: op.candidateKeyId,
            revokedKeyIds: op.revokeKeyIds,
          },
        });
      });
      return;
    }
    if (state.blockTimeMs > op.expiresAt.getTime()) {
      await finishExpired();
      return;
    }
    // Live-mode closures block new broadcasts, but must not block confirming earlier ones.
    assertLiveModeOpen();
    if (
      !op.signature ||
      op.expiresAt <= new Date() ||
      (op.lastAttemptAt && Date.now() - op.lastAttemptAt.getTime() < 15_000)
    )
      return;
    await prisma.nativeWalletKeyOperation.updateMany({
      where: { id, claimedAt: now },
      data: { lastAttemptAt: new Date() },
    });
    const intentHash = await nativeKeyRelay().publish(op.signature as object);
    await prisma.nativeWalletKeyOperation.updateMany({
      where: { id, claimedAt: now },
      data: { intentHash },
    });
  } catch {
    // Network failure, provider rejection, or ambiguous broadcast: retain the operation and nonce.
    // The worker retries; only a final block past its deadline proves an unused payload expired.
    log('warn', 'native wallet key change awaiting reconciliation', { operationId: id });
  } finally {
    await prisma.nativeWalletKeyOperation.updateMany({
      where: { id, claimedAt: now },
      data: { claimedAt: null },
    });
  }
}

export async function pollNativeKeyOperations() {
  const rows = await prisma.nativeWalletKeyOperation.findMany({
    where: { status: { in: PENDING } },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  });
  for (const row of rows) await processNativeKeyOperation(row.id);
}
