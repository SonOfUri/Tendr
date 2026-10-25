import { createHash, randomBytes } from 'node:crypto';
import { SignerKeySchema } from '@tendr/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { SoftAuthenticator } from '../test/authenticator.js';
import { createUser, resetDb } from '../test/helpers.js';
import { createDashboardSession, resolveDashboardSession } from './session.js';
import {
  activeCredentials,
  authenticationOptions,
  CEREMONY_CHALLENGE_TAG,
  coseToSignerKey,
  isCeremonyChallenge,
  registrationOptions,
  revokeCredential,
  signerKeyToCose,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.js';

async function register(user: { id: string; email: string }, auth: SoftAuthenticator) {
  const options = await registrationOptions(user);
  return verifyRegistration(user, auth.create(options), 'Laptop');
}

describe('webauthn', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('passkey_register_requires_uv_and_stores_signer_key (P-256, compressed)', async () => {
    const user = await createUser();
    const options = await registrationOptions(user);
    expect(options.authenticatorSelection?.userVerification).toBe('required');
    expect(options.pubKeyCredParams.map((p) => p.alg).sort((a, b) => a - b)).toEqual([-8, -7]);
    expect(options.rp).toEqual({ id: 'localhost', name: 'Tendr' });

    // Without UV the registration is refused and nothing is stored.
    const noUv = new SoftAuthenticator({ userVerified: false });
    await expect(verifyRegistration(user, noUv.create(options), 'x')).rejects.toMatchObject({
      status: 400,
    });
    expect(await prisma.webauthnCredential.count()).toBe(0);

    const auth = new SoftAuthenticator();
    const cred = await register(user, auth);
    expect(cred).toMatchObject({ userId: user.id, credentialId: auth.id, deviceLabel: 'Laptop' });
    const key = SignerKeySchema.parse(cred.publicKey);
    const { x, y } = auth.rawPublicKey;
    const expected = Buffer.concat([Buffer.from([0x02 | (y![31]! & 1)]), x]);
    expect(key).toEqual({ p256: expected.toString('base64') });
  });

  it('stores an EdDSA passkey as a raw ed25519 signer key', async () => {
    const user = await createUser();
    const auth = new SoftAuthenticator({ alg: 'EdDSA' });
    const cred = await register(user, auth);
    expect(cred.publicKey).toEqual({ ed25519: auth.rawPublicKey.x.toString('base64') });
  });

  it('converts signer keys back to COSE losslessly', async () => {
    const user = await createUser();
    for (const alg of ['ES256', 'EdDSA'] as const) {
      const cred = await register(user, new SoftAuthenticator({ alg }));
      const key = SignerKeySchema.parse(cred.publicKey);
      expect(coseToSignerKey(signerKeyToCose(key))).toEqual(key);
    }
  });

  it('a registration challenge is single-use and bound to its person', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const options = await registrationOptions(alice);
    const auth = new SoftAuthenticator();
    const response = auth.create(options);
    await expect(verifyRegistration(bob, response, null)).rejects.toMatchObject({ status: 400 });
    // The failed attempt by bob burned nothing of alice's: hers is still unused.
    await verifyRegistration(alice, response, null);
    await expect(
      verifyRegistration(alice, new SoftAuthenticator().create(options), null),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('logs in with a registered passkey and records its use', async () => {
    const user = await createUser();
    const auth = new SoftAuthenticator();
    await register(user, auth);
    const options = await authenticationOptions();
    expect(options.userVerification).toBe('required');
    // Always a discoverable login: no credential ids are disclosed.
    expect(options.allowCredentials ?? []).toEqual([]);
    const result = await verifyAuthentication(auth.get(options));
    expect(result.userId).toBe(user.id);
    const row = await prisma.webauthnCredential.findUniqueOrThrow({
      where: { credentialId: auth.id },
    });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.signCount).toBe(2n);
  });

  it('login challenges are single-use and expire after 5 minutes', async () => {
    const user = await createUser();
    const auth = new SoftAuthenticator();
    await register(user, auth);
    const options = await authenticationOptions();
    await verifyAuthentication(auth.get(options));
    await expect(verifyAuthentication(auth.get(options))).rejects.toMatchObject({ status: 401 });

    const stale = await authenticationOptions();
    await prisma.webauthnChallenge.updateMany({
      data: { expiresAt: new Date(Date.now() - 1) },
      where: { consumedAt: null },
    });
    await expect(verifyAuthentication(auth.get(stale))).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a login without user verification or from a foreign origin', async () => {
    const user = await createUser();
    const auth = new SoftAuthenticator();
    await register(user, auth);
    auth.userVerified = false;
    await expect(
      verifyAuthentication(auth.get(await authenticationOptions())),
    ).rejects.toMatchObject({ status: 401 });
    auth.userVerified = true;
    const options = await authenticationOptions();
    await expect(
      verifyAuthentication(auth.assert(options.challenge, { origin: 'https://evil.example' })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('login_assertion_cannot_be_used_as_approval: challenge namespaces differ', async () => {
    const user = await createUser();
    const auth = new SoftAuthenticator();
    await register(user, auth);
    const options = await authenticationOptions();
    const bytes = Buffer.from(options.challenge, 'base64url');
    // Approval challenges are exactly sha256(borsh(payload)) = 32 bytes. Ceremony challenges are
    // a fixed tag plus 32 random bytes, so no login/registration challenge can ever be one.
    expect(bytes.length).toBe(CEREMONY_CHALLENGE_TAG.length + 32);
    expect(bytes.subarray(0, CEREMONY_CHALLENGE_TAG.length)).toEqual(
      Buffer.from(CEREMONY_CHALLENGE_TAG),
    );
    expect(isCeremonyChallenge(bytes)).toBe(true);
    const payloadHash = createHash('sha256').update(randomBytes(64)).digest();
    expect(isCeremonyChallenge(payloadHash)).toBe(false);
    // And an assertion over a payload hash is never accepted as a login.
    await expect(
      verifyAuthentication(auth.assert(payloadHash.toString('base64url'))),
    ).rejects.toMatchObject({ status: 401 });
    // Registration challenges carry the same tag.
    const reg = await registrationOptions(user);
    expect(isCeremonyChallenge(Buffer.from(reg.challenge, 'base64url'))).toBe(true);
  });

  it('a public key cannot be registered twice while active; nor a credential id', async () => {
    const alice = await createUser();
    const mallory = await createUser();
    const auth = new SoftAuthenticator();
    await register(alice, auth);
    // Same key under a fresh credential id (none attestation lets anyone submit any key).
    auth.credentialId = randomBytes(16);
    await expect(register(mallory, auth)).rejects.toMatchObject({ status: 409 });
    await expect(register(alice, auth)).rejects.toMatchObject({ status: 409 });
    // Same credential id with a different key.
    const other = new SoftAuthenticator();
    other.credentialId = Buffer.from(auth.credentialId);
    await register(alice, other); // auth's new id was never stored
    const clash = new SoftAuthenticator();
    clash.credentialId = Buffer.from(other.credentialId);
    await expect(register(mallory, clash)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.webauthnCredential.count()).toBe(2);
  });

  it("revoking a passkey ends the person's other sessions, keeping the current one", async () => {
    const user = await createUser();
    const a = await register(user, new SoftAuthenticator());
    await register(user, new SoftAuthenticator());
    const current = await createDashboardSession(user.id, { passkeyVerified: true });
    const other = await createDashboardSession(user.id, { passkeyVerified: true });
    const stranger = await createDashboardSession((await createUser()).id);
    await revokeCredential(user.id, a.id, current.sessionId);
    expect(await resolveDashboardSession(current.token)).not.toBeNull();
    expect(await resolveDashboardSession(other.token)).toBeNull();
    expect(await resolveDashboardSession(stranger.token)).not.toBeNull();
  });

  it('revoked passkeys cannot log in, are not offered, and the last one cannot be revoked', async () => {
    const user = await createUser();
    const a = new SoftAuthenticator();
    const b = new SoftAuthenticator();
    const credA = await register(user, a);
    const credB = await register(user, b);
    await revokeCredential(user.id, credA.id);
    await expect(revokeCredential(user.id, credB.id)).rejects.toMatchObject({ status: 409 });
    expect((await activeCredentials(user.id)).map((c) => c.id)).toEqual([credB.id]);
    const options = await authenticationOptions();
    await expect(verifyAuthentication(a.get(options))).rejects.toMatchObject({ status: 401 });
    // Another person's passkey is not found.
    const other = await createUser();
    await expect(revokeCredential(other.id, credB.id)).rejects.toMatchObject({ status: 404 });
  });
});
