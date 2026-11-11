import type { NativeWallet, NativeWalletKey, Prisma } from '@prisma/client';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';
import { AppError, conflict } from '../lib/errors.js';
import { payloadChallenge, signedIntent } from './native-signing.js';
import { nativePublicKey } from './native-signing.js';
import type { SignerKey } from '@tendr/contracts';
import bs58 from 'bs58';

const invalid = () => new AppError('VALIDATION_ERROR', 'Wallet passkey could not be verified', 400);
export const walletKeyScope = (wallet: NativeWallet) => ({
  walletId: wallet.id,
  merchantId: wallet.merchantId,
  livemode: wallet.livemode,
});

/** Serialize registration across login/wallet tables, including concurrent recovery ceremonies. */
export async function reserveDedicatedWalletKey(
  tx: Prisma.TransactionClient,
  credentialId: string | null,
  publicKey: string,
  loginKey: SignerKey,
) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('tendr-key-role'), hashtext(${publicKey}))`;
  if (
    await tx.webauthnCredential.findFirst({
      where: {
        OR: [...(credentialId ? [{ credentialId }] : []), { publicKey: { equals: loginKey } }],
      },
    })
  )
    throw conflict('Create a dedicated wallet key, separate from your login');
}
export async function reserveDedicatedLoginKey(
  tx: Prisma.TransactionClient,
  credentialId: string,
  key: SignerKey,
) {
  const publicKey =
    'p256' in key
      ? nativePublicKey(key.p256)
      : `ed25519:${bs58.encode(Buffer.from(key.ed25519, 'base64'))}`;
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('tendr-key-role'), hashtext(${publicKey}))`;
  const where = { OR: [{ credentialId }, { publicKey }] };
  if (
    (await tx.nativeWallet.findFirst({ where })) ||
    (await tx.nativeWalletKey.findFirst({ where }))
  )
    throw conflict('Use a new login passkey, separate from your wallet');
}

/** Also covers registrations made by an old API process during a rolling deployment. Never reactivates a revoked key. */
export async function ensureInitialWalletKey(
  wallet: NativeWallet,
  db: Prisma.TransactionClient = prisma,
) {
  return db.nativeWalletKey.upsert({
    where: { id: `nwk_${wallet.id}` },
    update: {},
    create: {
      id: `nwk_${wallet.id}`,
      ...walletKeyScope(wallet),
      kind: 'passkey',
      label: 'Original wallet passkey',
      status: 'active',
      publicKey: wallet.publicKey,
      credentialId: wallet.credentialId,
      cosePublicKey: wallet.cosePublicKey,
      signCount: wallet.signCount,
      transports: wallet.transports,
      activatedAt: wallet.createdAt,
    },
  });
}

export async function activeWalletPasskeys(wallet: NativeWallet, excluding: string[] = []) {
  await ensureInitialWalletKey(wallet);
  return prisma.nativeWalletKey.findMany({
    where: {
      ...walletKeyScope(wallet),
      kind: 'passkey',
      status: 'active',
      id: { notIn: excluding },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function keyAuthenticationOptions(keys: NativeWalletKey[], payload: string) {
  if (!keys.length)
    throw conflict('Use a registered wallet passkey or your saved wallet recovery kit');
  return generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    challenge: Buffer.from(payloadChallenge(payload), 'base64url'),
    userVerification: 'required',
    allowCredentials: keys.map((key) => ({
      id: key.credentialId!,
      transports: [...new Set([...key.transports, 'hybrid'])] as AuthenticatorTransportFuture[],
    })),
  });
}

export async function verifyWalletKeyAssertion(
  key: NativeWalletKey,
  payload: string,
  response: AuthenticationResponseJSON,
) {
  if (
    key.kind !== 'passkey' ||
    !key.credentialId ||
    !key.cosePublicKey ||
    response.id !== key.credentialId
  )
    throw invalid();
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: payloadChallenge(payload),
      expectedOrigin: env().WEBAUTHN_ORIGINS,
      expectedRPID: env().WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: key.credentialId,
        publicKey: Buffer.from(key.cosePublicKey, 'base64'),
        counter: Number(key.signCount),
      },
    });
    if (!result.verified || !result.authenticationInfo.userVerified) throw invalid();
    return {
      keyId: key.id,
      signed: signedIntent(payload, key.publicKey, response.response),
      counter: BigInt(result.authenticationInfo.newCounter),
    };
  } catch {
    throw invalid();
  }
}

export async function recordWalletAssertion(
  tx: Prisma.TransactionClient,
  wallet: NativeWallet,
  keyId: string,
  counter: bigint,
) {
  const changed = await tx.nativeWalletKey.updateMany({
    where: {
      id: keyId,
      ...walletKeyScope(wallet),
      status: 'active',
      signCount: counter === 0n ? 0n : { lt: counter },
    },
    data: { signCount: counter },
  });
  if (changed.count !== 1) throw conflict('The wallet key changed; request a fresh challenge');
  // Compatibility while old application processes drain.
  if (keyId === `nwk_${wallet.id}`)
    await tx.nativeWallet.updateMany({
      where: {
        id: wallet.id,
        merchantId: wallet.merchantId,
        livemode: wallet.livemode,
        signCount: { lt: counter },
      },
      data: { signCount: counter },
    });
}
