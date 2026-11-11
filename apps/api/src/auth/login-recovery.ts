import { reserveDedicatedLoginKey } from '../accounts/native-wallet-keys.js';
// Personal login recovery, independent of store/contract/wallet recovery. No wallet keys move.
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { generateRegistrationOptions, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { env } from '../env.js';
import { nativePublicKey } from '../accounts/native-signing.js';
import { recordEvent } from '../events/record.js';
import { stepUpRequired } from '../gateway/principal.js';
import { sha256 } from '../lib/crypto.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getMailer } from './mailer.js';
import { newLinkToken, MAGIC_LINK_TTL_MS } from './magic-link.js';
import { isSteppedUp } from './session.js';
import {
  CHALLENGE_TTL_MS,
  claimedChallenge,
  newCeremonyChallenge,
  verifyRegistrationProof,
} from './webauthn.js';

export const LOGIN_RECOVERY_CODE_COUNT = 10;
export const LOGIN_RECOVERY_EVENTS = {
  codes: 'user.login_recovery_codes.rotated',
  completed: 'user.login_recovery.completed',
} as const;
const unavailable = () =>
  unauthorized('The recovery link or code is invalid, expired, or already used');
const codeHash = (userId: string, code: string) =>
  sha256(`tendr-login-recovery-v1:${userId}:${code.replace(/[\s-]/g, '').toUpperCase()}`);

export async function loginRecoveryStatus(userId: string) {
  const codes = await prisma.loginRecoveryCode.findMany({
    where: { userId, consumedAt: null, revokedAt: null },
    select: { createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return {
    enabled: codes.length > 0,
    remaining: codes.length,
    generatedAt: codes[0]?.createdAt ?? null,
  };
}

/** Returned once; only domain-separated hashes of 128-bit random codes are stored. */
export async function generateLoginRecoveryCodes(userId: string, sessionId: string) {
  const codes = Array.from(
    { length: LOGIN_RECOVERY_CODE_COUNT },
    () => `TDR1-${randomBytes(16).toString('hex').toUpperCase().match(/.{8}/g)!.join('-')}`,
  );
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const session = await tx.dashboardSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        recoveryMerchantId: null,
      },
    });
    if (!session || !isSteppedUp(session.passkeyVerifiedAt)) throw stepUpRequired();
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (
      !user.emailVerifiedAt ||
      !(await tx.webauthnCredential.count({ where: { userId, revokedAt: null } }))
    ) {
      throw conflict('Verify your email and register a login passkey before saving recovery codes');
    }
    const now = new Date();
    await tx.loginRecoveryCode.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.loginRecoveryRequest.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.loginRecoveryCode.createMany({
      data: codes.map((code) => ({ id: newId('lrc'), userId, codeHash: codeHash(userId, code) })),
    });
    await recordEvent(tx, null, {
      aggregateType: 'user',
      aggregateId: userId,
      type: LOGIN_RECOVERY_EVENTS.codes,
      payload: {},
    });
  });
  return { codes, remaining: codes.length };
}

/** Generic public response is supplied by the route, including for unknown/unprepared accounts. */
export async function requestLoginRecovery(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.emailVerifiedAt) return;
  const link = newLinkToken();
  const request = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
    if (
      !(await tx.loginRecoveryCode.count({
        where: { userId: user.id, consumedAt: null, revokedAt: null },
      }))
    )
      return null;
    return tx.loginRecoveryRequest.create({
      data: {
        id: newId('lrr'),
        userId: user.id,
        tokenHash: link.hash,
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      },
    });
  });
  if (!request) return;
  const url = new URL('/recover/login', env().WEB_URL);
  // Fragments never reach the HTTP server, access logs, or Referer header.
  url.hash = new URLSearchParams({ token: link.raw }).toString();
  try {
    await getMailer().send({
      to: user.email,
      template: 'login_recovery_link',
      data: { url: url.toString() },
    });
  } catch {
    // Preserve the generic public response during provider failures; never log the link/code.
    // A retry requests a fresh link. The saved code remains usable.
    log('error', 'Login recovery email delivery failed', { recoveryRequestId: request.id });
  }
}

/** Called under the person's row lock. Both factors must still be valid at final commit. */
async function proofs(tx: Prisma.TransactionClient, token: string, recoveryCode: string) {
  const request = await tx.loginRecoveryRequest.findUnique({ where: { tokenHash: sha256(token) } });
  const now = new Date();
  if (!request || request.consumedAt || request.expiresAt <= now) throw unavailable();
  const user = await tx.user.findUniqueOrThrow({ where: { id: request.userId } });
  const code = await tx.loginRecoveryCode.findFirst({
    where: {
      userId: user.id,
      codeHash: codeHash(user.id, recoveryCode),
      consumedAt: null,
      revokedAt: null,
    },
  });
  if (!user.emailVerifiedAt || !code) throw unavailable();
  return { request, user, code };
}

async function lockRecoveryUser(tx: Prisma.TransactionClient, token: string) {
  const r = await tx.loginRecoveryRequest.findUnique({
    where: { tokenHash: sha256(token) },
    select: { userId: true },
  });
  if (!r) throw unavailable();
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${r.userId} FOR UPDATE`;
}

export async function loginRecoveryOptions(token: string, recoveryCode: string) {
  const challenge = Buffer.from(newCeremonyChallenge()).toString('base64url');
  const user = await prisma.$transaction(async (tx) => {
    await lockRecoveryUser(tx, token);
    const { request, user, code } = await proofs(tx, token, recoveryCode);
    await tx.loginRecoveryRequest.update({
      where: { id: request.id },
      data: {
        challengeHash: sha256(challenge),
        codeId: code.id,
        challengeExpiresAt: new Date(
          Math.min(Date.now() + CHALLENGE_TTL_MS, request.expiresAt.getTime()),
        ),
      },
    });
    return user;
  });
  return generateRegistrationOptions({
    rpName: env().WEBAUTHN_RP_NAME,
    rpID: env().WEBAUTHN_RP_ID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    challenge: Buffer.from(challenge, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: [-7, -8],
    // Require a new credential; do not disclose existing credential IDs through recovery.
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

export async function completeLoginRecovery(
  token: string,
  recoveryCode: string,
  response: RegistrationResponseJSON,
  deviceLabel: string,
) {
  const challenge = claimedChallenge(response?.response?.clientDataJSON);
  if (!challenge) throw unavailable();
  // Reject invalid factors before spending work on attestation. Rechecked under lock below.
  await prisma.$transaction(async (tx) => {
    await proofs(tx, token, recoveryCode);
  });
  const proof = await verifyRegistrationProof(response, challenge);
  try {
    await prisma.$transaction(async (tx) => {
      await lockRecoveryUser(tx, token);
      const { request, user, code } = await proofs(tx, token, recoveryCode);
      const now = new Date();
      if (
        request.challengeHash !== sha256(challenge) ||
        request.codeId !== code.id ||
        !request.challengeExpiresAt ||
        request.challengeExpiresAt <= now
      )
        throw unavailable();
      // A "replacement" cannot reuse any historical login key or a dedicated wallet key.
      if (
        await tx.webauthnCredential.findFirst({
          where: {
            OR: [{ credentialId: proof.credentialId }, { publicKey: { equals: proof.publicKey } }],
          },
        })
      )
        throw conflict('Create a new passkey for recovery');
      if (
        await tx.nativeWallet.findFirst({
          where: {
            OR: [
              { credentialId: proof.credentialId },
              ...('p256' in proof.publicKey
                ? [{ publicKey: nativePublicKey(proof.publicKey.p256) }]
                : []),
            ],
          },
        })
      )
        throw conflict('Use a new login passkey, separate from your wallet');
      await reserveDedicatedLoginKey(tx, proof.credentialId, proof.publicKey);
      await tx.webauthnCredential.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.dashboardSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.webauthnCredential.create({
        data: { id: newId('cred'), userId: user.id, deviceLabel, ...proof },
      });
      await tx.loginRecoveryCode.update({ where: { id: code.id }, data: { consumedAt: now } });
      // Invalidate every older email/ceremony for this recovery, including concurrent attempts.
      await tx.loginRecoveryRequest.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.emailToken.updateMany({
        where: {
          email: user.email,
          consumedAt: null,
          purpose: { in: ['verify', 'login', 'recovery_register'] },
        },
        data: { consumedAt: now },
      });
      await tx.webauthnChallenge.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await recordEvent(tx, null, {
        aggregateType: 'user',
        aggregateId: user.id,
        type: LOGIN_RECOVERY_EVENTS.completed,
        payload: {},
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw conflict('Create a new passkey for recovery');
    throw err;
  }
  // Deliberately does not create a session: sign in using the newly registered passkey.
  return { recovered: true };
}
