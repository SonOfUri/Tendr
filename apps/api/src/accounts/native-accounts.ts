import { Prisma, type NativeWallet } from '@prisma/client';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { coseToSignerKey, newCeremonyChallenge, CHALLENGE_TTL_MS } from '../auth/webauthn.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, forbidden } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertNativeMode, usesTidepool, intentsContractFor } from '../lib/testnet.js';
import { isUnknownAccountOrKey } from '../near/rpc.js';
import { TIDEPOOL_TOKENS } from '../checkout/oneclick/tidepool.js';
import { prisma } from '../lib/prisma.js';
import { nearClient } from '../near/client.js';
import { tokenInfo } from '../checkout/tokens.js';
import { SETTLEMENT_CHOICES } from './settlement.js';
import { activationPayload, nativePublicKey, nativeAccountId } from './native-signing.js';

import {
  activeWalletPasskeys,
  keyAuthenticationOptions,
  verifyWalletKeyAssertion,
  ensureInitialWalletKey,
  recordWalletAssertion,
  reserveDedicatedWalletKey,
} from './native-wallet-keys.js';

export type NativeActor = { merchantId: string; userId: string; livemode: boolean };
const scope = (a: NativeActor) => ({ merchantId: a.merchantId, livemode: a.livemode });
const invalid = () => new AppError('VALIDATION_ERROR', 'Wallet passkey could not be verified', 400);

export async function requireNativeOwner(actor: NativeActor) {
  if (!actor.livemode) assertNativeMode(false);
  const member = await prisma.merchantUser.findFirst({
    where: { merchantId: actor.merchantId, userId: actor.userId },
  });
  if (member?.role !== 'owner') throw forbidden('Only an owner can manage this wallet');
}

/** A legacy Test placeholder can be replaced only when no NEAR account or Tidepool funds exist.
 * The old identity is retained in an audit event; live accounts are never candidates.
 */
async function registrationAccount(actor: NativeActor) {
  const old = await prisma.merchantAccount.findFirst({ where: scope(actor) });
  if (!old) return null;
  if (!usesTidepool(actor.livemode) || old.kind !== 'contract')
    throw conflict('This store already has an account; activate its wallet');
  if (old.provisionClaimedAt && old.provisionClaimedAt.getTime() > Date.now() - 5 * 60_000)
    throw conflict('Wait for the previous Test account setup to finish');
  let exists = true;
  try {
    await nearClient(false).viewAccount(old.nearAccountId);
  } catch (error) {
    if (!isUnknownAccountOrKey(error)) throw error;
    exists = false;
  }
  if (exists)
    throw conflict(
      'This store has an on-chain legacy Test account. Use a new store for Tidepool; its existing wallet is preserved.',
    );
  const balances = await nearClient(false).view<string[]>(
    intentsContractFor(false),
    'mt_batch_balance_of',
    {
      account_id: old.nearAccountId,
      token_ids: Object.values(TIDEPOOL_TOKENS).map((t) => t.assetId),
    },
  );
  if (balances.length !== 6 || balances.some((value) => value !== '0'))
    throw conflict('The previous Test identity has funds; its wallet must be preserved');
  return old;
}

export async function ownedNativeWallet(actor: NativeActor, active = true) {
  await requireNativeOwner(actor);
  const wallet = await prisma.nativeWallet.findFirst({
    where: scope(actor),
    include: { account: true },
  });
  if (!wallet || wallet.ownerUserId !== actor.userId)
    throw forbidden('This store wallet belongs to a different owner or has not been registered');
  if (wallet.account.kind !== 'native_intents' || (active && wallet.account.status !== 'active')) {
    throw conflict('Activate the store wallet first');
  }
  return wallet;
}

export async function nativeRegistrationOptions(actor: NativeActor) {
  assertNativeMode(actor.livemode);
  await requireNativeOwner(actor);
  if (actor.livemode && env().LIVE_ACCOUNT_DRIVER !== 'native_intents')
    throw conflict('Native account registration is not enabled');
  await registrationAccount(actor);
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: actor.merchantId } });
  const challenge = Buffer.from(newCeremonyChallenge()).toString('base64url');
  await prisma.webauthnChallenge.create({
    data: {
      id: newId('wch'),
      purpose: 'native_wallet_registration',
      userId: actor.userId,
      ...scope(actor),
      challengeHash: sha256(challenge),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  return generateRegistrationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    rpName: env().WEBAUTHN_RP_NAME,
    userID: new TextEncoder().encode(`${actor.merchantId}:${actor.livemode ? 'live' : 'test'}`),
    userName: `${merchant.name} — ${actor.livemode ? 'live' : 'test'} wallet`,
    userDisplayName: `${merchant.name} wallet`,
    challenge: Buffer.from(challenge, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: [-7],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // A new store has a distinct user handle and no wallet credential to exclude. Excluding
    // login keys or other stores' keys rejects their entire authenticator, preventing that
    // device/password manager from creating a NEW key here. Verification below and the DB
    // uniqueness constraints still forbid reusing those credential IDs or public keys.
    excludeCredentials: [],
  });
}

/** Registration is followed by an assertion: attestation:none alone is NOT proof of ownership. */
export async function registerNativeWallet(actor: NativeActor, response: RegistrationResponseJSON) {
  assertNativeMode(actor.livemode);
  await requireNativeOwner(actor);
  if (actor.livemode && env().LIVE_ACCOUNT_DRIVER !== 'native_intents')
    throw conflict('Native account registration is not enabled');
  let challenge: string;
  let registration: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
    const consumed = await prisma.webauthnChallenge.updateMany({
      where: {
        ...scope(actor),
        userId: actor.userId,
        purpose: 'native_wallet_registration',
        challengeHash: sha256(challenge),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();
    registration = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: env().WEBAUTHN_ORIGINS,
      expectedRPID: env().WEBAUTHN_RP_ID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7],
    });
  } catch {
    throw invalid();
  }
  if (!registration.verified || !registration.registrationInfo.userVerified) throw invalid();
  const credential = registration.registrationInfo.credential;
  const key = coseToSignerKey(credential.publicKey);
  if (!('p256' in key)) throw invalid();
  const publicKey = nativePublicKey(key.p256);
  const accountId = nativeAccountId(publicKey);
  const previous = await registrationAccount(actor);
  // A dedicated credential prevents stores sharing a login key (and therefore sharing funds).
  if (
    await prisma.webauthnCredential.findFirst({
      where: { OR: [{ credentialId: credential.id }, { publicKey: { equals: key } }] },
    })
  )
    throw conflict('Create a separate wallet passkey; login passkeys cannot be reused');
  try {
    await tenantTransaction(actor, async (tx) => {
      await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${actor.merchantId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM merchant_users WHERE merchant_id = ${actor.merchantId} AND user_id = ${actor.userId} FOR UPDATE`;
      if (
        !(await tx.merchantUser.findFirst({
          where: { merchantId: actor.merchantId, userId: actor.userId, role: 'owner' },
        }))
      )
        throw forbidden('Only an owner can manage this wallet');
      const current = await tx.merchantAccount.findFirst({ where: scope(actor) });
      if (
        current &&
        (!previous ||
          current.id !== previous.id ||
          current.kind !== 'contract' ||
          current.updatedAt.getTime() !== previous.updatedAt.getTime())
      )
        throw conflict('An account already exists or changed during registration');
      if (previous)
        await recordEvent(tx, actor, {
          aggregateType: 'merchant_account',
          aggregateId: previous.id,
          type: 'merchant_account.legacy_test_replaced',
          payload: {
            previous: JSON.parse(
              JSON.stringify(previous, (_key, value) =>
                typeof value === 'bigint' ? value.toString() : value,
              ),
            ),
          },
        });
      await reserveDedicatedWalletKey(tx, credential.id, publicKey, key);
      const accountData = {
        ...scope(actor),
        kind: 'native_intents' as const,
        nearAccountId: accountId,
        threshold: 1,
        status: 'provisioning' as const,
        contractCodeHash: null,
        createdTx: null,
        provisionAttemptId: null,
        provisionClaimedAt: null,
        storageLowAt: null,
        reconciledAt: null,
        signerEpoch: 0n,
        proposalsSeen: 0,
        recoveryKeyEpoch: null,
      };
      const account = previous
        ? await tx.merchantAccount.update({ where: { id: previous.id }, data: accountData })
        : await tx.merchantAccount.create({ data: { id: newId('macc'), ...accountData } });
      const wallet = await tx.nativeWallet.create({
        data: {
          id: newId('nwal'),
          ...scope(actor),
          accountId: account.id,
          ownerUserId: actor.userId,
          credentialId: credential.id,
          publicKey,
          cosePublicKey: Buffer.from(credential.publicKey).toString('base64'),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
        },
      });
      await ensureInitialWalletKey(wallet, tx);
      await recordEvent(tx, actor, {
        aggregateType: 'merchant_account',
        aggregateId: account.id,
        type: 'merchant_account.native_registered',
        payload: { nearAccountId: accountId, ownerUserId: actor.userId },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw conflict('This wallet credential is already in use');
    throw err;
  }
  return nativeActivationOptions(actor);
}

export async function nativeAuthenticationOptions(wallet: NativeWallet, payload: string) {
  return keyAuthenticationOptions(await activeWalletPasskeys(wallet), payload);
}

export async function verifyNativeAssertion(
  wallet: NativeWallet,
  payload: string,
  response: AuthenticationResponseJSON,
) {
  const key = (await activeWalletPasskeys(wallet)).find((k) => k.credentialId === response.id);
  if (!key) throw invalid();
  return verifyWalletKeyAssertion(key, payload, response);
}

export async function nativeActivationOptions(actor: NativeActor) {
  assertNativeMode(actor.livemode);
  const wallet = await ownedNativeWallet(actor, false);
  if (wallet.account.status === 'active') throw conflict('The wallet is already active');
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  const payload = activationPayload(
    wallet.account.nearAccountId,
    intentsContractFor(actor.livemode),
    expires,
  );
  await prisma.nativeWallet.updateMany({
    where: { id: wallet.id, ...scope(actor) },
    data: { activationPayload: payload, activationExpiresAt: expires },
  });
  return {
    accountId: wallet.account.nearAccountId,
    payload,
    publicKey: wallet.publicKey,
    options: await nativeAuthenticationOptions(wallet, payload),
    expiresAt: expires,
  };
}

export async function activateNativeWallet(
  actor: NativeActor,
  response: AuthenticationResponseJSON,
) {
  assertNativeMode(actor.livemode);
  const wallet = await ownedNativeWallet(actor, false);
  if (wallet.account.status === 'active') return wallet.account;
  if (
    !wallet.activationPayload ||
    !wallet.activationExpiresAt ||
    wallet.activationExpiresAt <= new Date()
  )
    throw conflict('Request a fresh wallet activation challenge');
  const { signed, counter, keyId } = await verifyNativeAssertion(
    wallet,
    wallet.activationPayload,
    response,
  );
  const simulation = await nearClient(actor.livemode).view<{
    intents_executed?: unknown[];
    invariant_violated?: unknown;
  }>(intentsContractFor(actor.livemode), 'simulate_intents', { signed: [signed] });
  if (simulation.intents_executed?.length !== 1 || simulation.invariant_violated)
    throw conflict('The Intents verifier did not accept this wallet');
  return tenantTransaction(actor, async (tx) => {
    const consumed = await tx.nativeWallet.updateMany({
      where: {
        id: wallet.id,
        ...scope(actor),
        activationPayload: wallet.activationPayload,
        activationExpiresAt: { gt: new Date() },
      },
      data: { activationPayload: null, activationExpiresAt: null, signCount: counter },
    });
    if (consumed.count !== 1)
      throw conflict('The activation challenge was replaced or already used');
    await recordWalletAssertion(tx, wallet, keyId, counter);
    await tx.merchantAccount.updateMany({
      where: {
        id: wallet.accountId,
        ...scope(actor),
        kind: 'native_intents',
        status: 'provisioning',
      },
      data: { status: 'active' },
    });
    await tx.settlementConfig.updateMany({ where: scope(actor), data: { isDefault: false } });
    await tx.settlementConfig.create({
      data: {
        id: newId('stc'),
        ...scope(actor),
        destAssetId: usesTidepool(actor.livemode)
          ? TIDEPOOL_TOKENS.nearUsdc.assetId
          : SETTLEMENT_CHOICES.live[0]!.asset,
        destChain: 'near',
        payoutMode: 'intents',
        isDefault: true,
      },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'merchant_account',
      aggregateId: wallet.accountId,
      type: 'merchant_account.native_activated',
      payload: { nearAccountId: wallet.account.nearAccountId },
    });
    return tx.merchantAccount.findFirstOrThrow({
      where: { id: wallet.accountId, ...scope(actor) },
    });
  });
}

export async function setNativeSettlement(actor: NativeActor, asset: string) {
  assertNativeMode(actor.livemode);
  await ownedNativeWallet(actor);
  await tokenInfo(actor.livemode, asset);
  if (!asset.startsWith('nep141:'))
    throw new AppError('UNSUPPORTED_ASSET', 'Choose a supported NEP-141 settlement asset', 400);
  await tenantTransaction(actor, async (tx) => {
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${actor.merchantId} FOR UPDATE`;
    await tx.settlementConfig.updateMany({ where: scope(actor), data: { isDefault: false } });
    await tx.settlementConfig.create({
      data: {
        id: newId('stc'),
        ...scope(actor),
        destAssetId: asset,
        destChain: 'near',
        payoutMode: 'intents',
        isDefault: true,
      },
    });
    await recordEvent(tx, actor, {
      aggregateType: 'merchant_account',
      aggregateId: actor.merchantId,
      type: 'merchant_account.native_settlement_changed',
      payload: { asset },
    });
  });
}
