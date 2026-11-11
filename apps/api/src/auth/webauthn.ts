// Passkeys (WebAuthn) for dashboard login, via `@simplewebauthn/server`.
//
// - Algorithms: ES256 (P-256) and EdDSA (Ed25519) only, the two the merchant-account contract
//   verifies. User verification is required on every ceremony.
// - The public key is stored as the contract's `SignerKey` JSON — `{ "p256": <33-byte compressed
//   SEC1> }` or `{ "ed25519": <32 bytes> }` (standard base64) — so the same row can be registered
//   on chain as a signer key.
// - Ceremony challenges (registration and login) are server-issued, single-use and valid for
//   5 minutes; only their sha256 is stored (`webauthn_challenges`). Each is
//   `CEREMONY_CHALLENGE_TAG ‖ 32 random bytes`. Proposal approvals sign a bare 32-byte
//   `sha256(borsh(ApprovalPayload))`, so a login/registration assertion can never be an approval
//   and an approval assertion can never be a login (its challenge was never issued here).
// - Attestation is `none`, so a client can submit ANY public key. An active public key is unique
//   (partial unique index), so nobody can register someone else's key. Still, a stored key proves
//   only that its registrant controls it: on-chain signer mirroring and approvals must map a
//   signer by (user_id, credential row id) — never look a person up by public key alone.
// - Revoked credentials (`revoked_at` set) are ignored everywhere: login, `allowCredentials`,
//   and `activeCredentials` (the lookup approvals must use).
import { randomBytes } from 'node:crypto';
import { p256 } from '@noble/curves/p256';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoCBOR } from '@simplewebauthn/server/helpers';
import { Prisma, type WebauthnCredential } from '@prisma/client';
import { SignerKeySchema, type SignerKey } from '@tendr/contracts';
import { env } from '../env.js';
import { stepUpRequired } from '../gateway/principal.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isSteppedUp } from './session.js';

export const CEREMONY_CHALLENGE_TAG = new TextEncoder().encode('tendr-webauthn-ceremony-v1:');
export const CHALLENGE_TTL_MS = 5 * 60_000;

const ES256 = -7;
const EDDSA = -8;
const SUPPORTED_ALGS = [ES256, EDDSA];

type ChallengePurpose = 'registration' | 'authentication';

/** A fresh ceremony challenge: the fixed tag followed by 32 random bytes. */
export function newCeremonyChallenge(): Uint8Array {
  return new Uint8Array(Buffer.concat([CEREMONY_CHALLENGE_TAG, randomBytes(32)]));
}

/** Whether `bytes` has the shape of a ceremony challenge (never a 32-byte payload hash). */
export function isCeremonyChallenge(bytes: Uint8Array): boolean {
  const tag = CEREMONY_CHALLENGE_TAG;
  return (
    bytes.length === tag.length + 32 &&
    Buffer.from(bytes.subarray(0, tag.length)).equals(Buffer.from(tag))
  );
}

async function issueChallenge(purpose: ChallengePurpose, userId: string | null): Promise<string> {
  const challenge = Buffer.from(newCeremonyChallenge()).toString('base64url');
  await prisma.webauthnChallenge.create({
    data: {
      id: newId('wch'),
      purpose,
      challengeHash: sha256(challenge),
      userId,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
  return challenge;
}

/** Atomically consumes an unexpired, unused challenge issued for `purpose` (and `userId`). */
async function consumeChallenge(
  challenge: string,
  purpose: ChallengePurpose,
  userId: string | null,
): Promise<boolean> {
  if (!isCeremonyChallenge(Buffer.from(challenge, 'base64url'))) return false;
  const now = new Date();
  const { count } = await prisma.webauthnChallenge.updateMany({
    where: {
      challengeHash: sha256(challenge),
      purpose,
      userId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  return count === 1;
}

/** The challenge a client response claims to answer (base64url), or null if unreadable. */
export function claimedChallenge(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const { challenge } = decodeClientDataJSON(clientDataJSON);
    return typeof challenge === 'string' ? challenge : null;
  } catch {
    return null;
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** COSE public key → `SignerKey`. Only ES256/P-256 and EdDSA/Ed25519 are accepted. */
export function coseToSignerKey(coseKey: Uint8Array): SignerKey {
  const map = isoCBOR.decodeFirst<Map<number, unknown>>(new Uint8Array(coseKey));
  const [kty, alg, crv, x, y] = [1, 3, -1, -2, -3].map((k) => map.get(k));
  const bytes = (v: unknown, len: number) =>
    v instanceof Uint8Array && v.length === len ? v : null;
  if (kty === 2 && alg === ES256 && crv === 1) {
    const xb = bytes(x, 32);
    const yb = bytes(y, 32);
    if (xb && yb) {
      const compressed = new Uint8Array(33);
      compressed[0] = 0x02 | (yb[31]! & 1);
      compressed.set(xb, 1);
      // Rejects points that are not on the curve.
      p256.ProjectivePoint.fromHex(compressed).assertValidity();
      return { p256: b64(compressed) };
    }
  }
  if (kty === 1 && alg === EDDSA && crv === 6) {
    const xb = bytes(x, 32);
    if (xb) return { ed25519: b64(xb) };
  }
  throw new AppError(
    'VALIDATION_ERROR',
    'Unsupported passkey algorithm (ES256 or EdDSA only)',
    400,
  );
}

/** `SignerKey` → COSE public key, for verifying assertions against a stored credential. */
export function signerKeyToCose(key: SignerKey): ReturnType<typeof isoCBOR.encode> {
  if ('p256' in key) {
    const raw = p256.ProjectivePoint.fromHex(Buffer.from(key.p256, 'base64')).toRawBytes(false);
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, ES256],
        [-1, 1],
        [-2, raw.slice(1, 33)],
        [-3, raw.slice(33, 65)],
      ]),
    );
  }
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 1],
      [3, EDDSA],
      [-1, 6],
      [-2, new Uint8Array(Buffer.from(key.ed25519, 'base64'))],
    ]),
  );
}

/** A person's non-revoked passkeys, oldest first. Approvals must look credentials up here. */
export function activeCredentials(userId: string): Promise<WebauthnCredential[]> {
  return prisma.webauthnCredential.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

const transportsOf = (c: WebauthnCredential) => c.transports as AuthenticatorTransportFuture[];

export async function registrationOptions(user: {
  id: string;
  email: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME } = env();
  const existing = await activeCredentials(user.id);
  const challenge = await issueChallenge('registration', user.id);
  return generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID: WEBAUTHN_RP_ID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    challenge: Buffer.from(challenge, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: SUPPORTED_ALGS,
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: transportsOf(c) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

const registrationFailed = () =>
  new AppError('VALIDATION_ERROR', 'Passkey registration could not be verified', 400);

/** Cryptographic verification only; the caller must authorize and consume its own challenge. */
export async function verifyRegistrationProof(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  const { WEBAUTHN_RP_ID, WEBAUTHN_ORIGINS } = env();
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGS,
    });
  } catch {
    throw registrationFailed();
  }
  if (!verified.verified || !verified.registrationInfo.userVerified) throw registrationFailed();
  const { credential } = verified.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: SignerKeySchema.parse(coseToSignerKey(credential.publicKey)),
    signCount: BigInt(credential.counter),
    transports: credential.transports ?? response.response.transports ?? [],
  };
}

/**
 * The dashboard session registering a passkey: kept alive when this is the person's first passkey
 * (every other session of theirs ends), and whether it holds a recent assertion (needed for any
 * passkey after the first).
 */
export type RegisteringSession = {
  sessionId: string;
  steppedUp: boolean;
  /**
   * Runs inside the transaction that inserts the credential (e.g. the recovery-session event,
   * M7), so the credential exists if and only if it does.
   */
  onCreated?: (tx: Prisma.TransactionClient, credential: WebauthnCredential) => Promise<void>;
};

/**
 * Verifies a registration and stores the passkey. The person's first-passkey check and the insert
 * are serialised on their `users` row (`SELECT … FOR UPDATE`), so two passkey-less sessions racing
 * cannot both register a "first" passkey: the loser sees one exists and, unless its session is
 * stepped up, gets STEP_UP_REQUIRED. Registering the first passkey ends the person's other
 * dashboard sessions (an email-link session elsewhere must not outlive the switch to passkeys).
 *
 * Without `session` (internal callers and tests) no step-up is enforced and, for a first passkey,
 * every session of the person ends.
 */
export async function verifyRegistration(
  user: { id: string },
  response: RegistrationResponseJSON,
  deviceLabel: string | null,
  session?: RegisteringSession,
): Promise<{ credential: WebauthnCredential; first: boolean }> {
  const challenge = claimedChallenge(response?.response?.clientDataJSON);
  if (!challenge || !(await consumeChallenge(challenge, 'registration', user.id))) {
    throw registrationFailed();
  }
  const proof = await verifyRegistrationProof(response, challenge);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const existing = await tx.webauthnCredential.count({
        where: { userId: user.id, revokedAt: null },
      });
      const first = existing === 0;
      if (session) {
        const current = await tx.dashboardSession.findFirst({
          where: {
            id: session.sessionId,
            userId: user.id,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (!current) throw unauthorized('Your session ended; sign in again');
        if (!first && (!session.steppedUp || !isSteppedUp(current.passkeyVerifiedAt)))
          throw stepUpRequired();
      }
      const created = await tx.webauthnCredential.create({
        data: {
          id: newId('cred'),
          userId: user.id,
          ...proof,
          deviceLabel,
        },
      });
      await session?.onCreated?.(tx, created);
      if (first) {
        await tx.dashboardSession.updateMany({
          where: {
            userId: user.id,
            revokedAt: null,
            ...(session ? { id: { not: session.sessionId } } : {}),
          },
          data: { revokedAt: new Date() },
        });
      }
      return { credential: created, first };
    });
  } catch (err) {
    // The credential id, or the active public key, is already registered (to anyone).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('This passkey is already registered');
    }
    throw err;
  }
}

/**
 * Login options: always a discoverable login with an empty `allowCredentials`, so the endpoint
 * neither reveals whether an email has an account nor discloses credential ids.
 */
export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const challenge = await issueChallenge('authentication', null);
  return generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    challenge: Buffer.from(challenge, 'base64url'),
    userVerification: 'required',
    allowCredentials: [],
  });
}

/**
 * Step-up options for an already signed-in person: their active passkeys are offered (the
 * session already knows who they are). Verified with `verifyAuthentication`; the caller must
 * check that the returned person is the session's.
 */
export async function stepUpOptions(
  userId: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const creds = await activeCredentials(userId);
  const challenge = await issueChallenge('authentication', null);
  return generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    challenge: Buffer.from(challenge, 'base64url'),
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: transportsOf(c) })),
  });
}

const loginFailed = () => unauthorized('Passkey login failed');

/** Verifies a login assertion and returns the person it belongs to. */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
): Promise<{ userId: string; credentialId: string }> {
  const challenge = claimedChallenge(response?.response?.clientDataJSON);
  if (!challenge || !(await consumeChallenge(challenge, 'authentication', null))) {
    throw loginFailed();
  }
  const cred =
    typeof response.id === 'string'
      ? await prisma.webauthnCredential.findUnique({ where: { credentialId: response.id } })
      : null;
  if (!cred || cred.revokedAt) throw loginFailed();
  const key = SignerKeySchema.parse(cred.publicKey);
  const { WEBAUTHN_RP_ID, WEBAUTHN_ORIGINS } = env();
  let newCounter: number;
  try {
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: WEBAUTHN_ORIGINS,
      expectedRPID: WEBAUTHN_RP_ID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: signerKeyToCose(key),
        counter: Number(cred.signCount),
        transports: transportsOf(cred),
      },
    });
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw loginFailed();
    newCounter = verified.authenticationInfo.newCounter;
  } catch (err) {
    log('info', 'passkey login rejected', { credentialId: cred.id, err: String(err) });
    throw loginFailed();
  }
  const { count } = await prisma.webauthnCredential.updateMany({
    where: { id: cred.id, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
  if (count === 0) throw loginFailed();
  await recordSignCount(cred.id, newCounter);
  return { userId: cred.userId, credentialId: cred.id };
}

/**
 * Raises a credential's stored signature counter to `counter`. Monotonic: a concurrent or late
 * write with a lower counter never moves it back.
 */
export async function recordSignCount(credentialRowId: string, counter: number): Promise<void> {
  await prisma.webauthnCredential.updateMany({
    where: { id: credentialRowId, signCount: { lt: BigInt(counter) } },
    data: { signCount: BigInt(counter) },
  });
}

/**
 * Revokes one of the person's own passkeys. Refuses to revoke their last active one (they would
 * be locked out). Serialised per person, so two concurrent revocations cannot both pass. Every
 * other dashboard session of the person ends too (a lost device may hold one); the session
 * `keepSessionId` doing the revocation survives.
 */
export async function revokeCredential(
  userId: string,
  credentialRowId: string,
  keepSessionId?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const active = await tx.webauthnCredential.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    if (!active.some((c) => c.id === credentialRowId)) throw notFound('Passkey not found');
    if (active.length < 2) throw conflict('Cannot remove your only passkey; add another first');
    const now = new Date();
    await tx.webauthnCredential.update({
      where: { id: credentialRowId },
      data: { revokedAt: now },
    });
    await tx.dashboardSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
      },
      data: { revokedAt: now },
    });
  });
}
