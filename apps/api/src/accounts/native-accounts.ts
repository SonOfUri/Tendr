import { Prisma, type NativeWallet } from '@prisma/client';
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { coseToSignerKey, newCeremonyChallenge, CHALLENGE_TTL_MS } from '../auth/webauthn.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, forbidden } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertLiveModeOpen } from '../lib/live-mode.js';
import { prisma } from '../lib/prisma.js';
import { nearClient } from '../near/client.js';
import { tokenInfo } from '../checkout/tokens.js';
import { SETTLEMENT_CHOICES } from './settlement.js';
import {
  activationPayload,
  nativePublicKey,
  nativeAccountId,
  payloadChallenge,
  signedIntent,
} from './native-signing.js';

export type NativeActor = { merchantId: string; userId: string; livemode: boolean };
const scope = (a: NativeActor) => ({ merchantId: a.merchantId, livemode: a.livemode });
const invalid = () => new AppError('VALIDATION_ERROR', 'Wallet passkey could not be verified', 400);

export async function requireNativeOwner(actor: NativeActor) {
  if (!actor.livemode) throw conflict('Native Intents wallets are available in live mode only');
  const member = await prisma.merchantUser.findFirst({
    where: { merchantId: actor.merchantId, userId: actor.userId },
  });
  if (member?.role !== 'owner') throw forbidden('Only an owner can manage this wallet');
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
  assertLiveModeOpen();
  await requireNativeOwner(actor);
  if (env().LIVE_ACCOUNT_DRIVER !== 'native_intents')
    throw conflict('Native account registration is not enabled');
  if (await prisma.merchantAccount.findFirst({ where: scope(actor) })) {
    throw conflict('This store already has a live account; activate its wallet or contact support');
  }
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
    userID: new TextEncoder().encode(`${actor.merchantId}:live`),
    userName: `${merchant.name} — live wallet`,
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
  assertLiveModeOpen();
  await requireNativeOwner(actor);
  if (env().LIVE_ACCOUNT_DRIVER !== 'native_intents')
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
      if (await tx.merchantAccount.findFirst({ where: scope(actor) }))
        throw conflict('A live account already exists');
      const account = await tx.merchantAccount.create({
        data: {
          id: newId('macc'),
          ...scope(actor),
          kind: 'native_intents',
          nearAccountId: accountId,
          threshold: 1,
          status: 'provisioning',
        },
      });
      await tx.nativeWallet.create({
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
  return generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    challenge: Buffer.from(payloadChallenge(payload), 'base64url'),
    userVerification: 'required',
    allowCredentials: [
      { id: wallet.credentialId, transports: wallet.transports as AuthenticatorTransportFuture[] },
    ],
  });
}

export async function verifyNativeAssertion(
  wallet: NativeWallet,
  payload: string,
  response: AuthenticationResponseJSON,
) {
  if (response.id !== wallet.credentialId) throw invalid();
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: payloadChallenge(payload),
      expectedOrigin: env().WEBAUTHN_ORIGINS,
      expectedRPID: env().WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: wallet.credentialId,
        publicKey: Buffer.from(wallet.cosePublicKey, 'base64'),
        counter: Number(wallet.signCount),
      },
    });
    if (!result.verified || !result.authenticationInfo.userVerified) throw invalid();
    return {
      signed: signedIntent(payload, wallet.publicKey, response.response),
      counter: BigInt(result.authenticationInfo.newCounter),
    };
  } catch {
    throw invalid();
  }
}

export async function nativeActivationOptions(actor: NativeActor) {
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor, false);
  if (wallet.account.status === 'active') throw conflict('The wallet is already active');
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  const payload = activationPayload(
    wallet.account.nearAccountId,
    env().INTENTS_CONTRACT_LIVE,
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
  assertLiveModeOpen();
  const wallet = await ownedNativeWallet(actor, false);
  if (wallet.account.status === 'active') return wallet.account;
  if (
    !wallet.activationPayload ||
    !wallet.activationExpiresAt ||
    wallet.activationExpiresAt <= new Date()
  )
    throw conflict('Request a fresh wallet activation challenge');
  const { signed, counter } = await verifyNativeAssertion(
    wallet,
    wallet.activationPayload,
    response,
  );
  const simulation = await nearClient(true).view<{
    intents_executed?: unknown[];
    invariant_violated?: unknown;
  }>(env().INTENTS_CONTRACT_LIVE, 'simulate_intents', { signed: [signed] });
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
    await tx.merchantAccount.updateMany({
      where: {
        id: wallet.accountId,
        ...scope(actor),
        kind: 'native_intents',
        status: 'provisioning',
      },
      data: { status: 'active' },
    });
    await tx.settlementConfig.create({
      data: {
        id: newId('stc'),
        ...scope(actor),
        destAssetId: SETTLEMENT_CHOICES.live[0]!.asset,
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
  assertLiveModeOpen();
  await ownedNativeWallet(actor);
  await tokenInfo(true, asset);
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
