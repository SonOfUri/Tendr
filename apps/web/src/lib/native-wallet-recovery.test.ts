import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  createNativeKit,
  encodeNativeKit,
  nativeKitPublicKey,
  readNativeKit,
  signNativeKitProof,
  signNativeKitRecovery,
  validateNativeKeyChange,
  type KeyChangeReview,
} from './native-wallet-recovery';

const accountId = `0x${'12'.repeat(20)}`;
function review(): KeyChangeReview {
  const change: KeyChangeReview = {
    id: 'op1',
    kind: 'recover',
    accountId,
    contract: 'intents.near',
    addedKey: { id: 'new', publicKey: 'p256:new' },
    removedKeys: [{ id: 'old', publicKey: 'p256:old' }],
    payload: '',
  };
  change.payload = JSON.stringify({
    signer_id: accountId,
    verifying_contract: 'intents.near',
    deadline: new Date(Date.now() + 240000).toISOString(),
    nonce: Buffer.alloc(32, 1).toString('base64'),
    intents: [
      { intent: 'add_public_key', public_key: 'p256:new' },
      { intent: 'remove_public_key', public_key: 'p256:old' },
    ],
  });
  return change;
}
describe('browser-only native wallet recovery kit', () => {
  it('requires the versioned kit for the exact wallet and RP; login codes are rejected', () => {
    const kit = createNativeKit(accountId, 'usetendr.tech');
    expect(readNativeKit(encodeNativeKit(kit), accountId, 'usetendr.tech')).toEqual(kit);
    expect(() => readNativeKit(encodeNativeKit(kit), 'another-wallet', 'usetendr.tech')).toThrow(
      /different/,
    );
    expect(() => readNativeKit(encodeNativeKit(kit), accountId, 'evil.example')).toThrow(
      /different/,
    );
    expect(() => readNativeKit('LOGIN-RECOVERY-CODE', accountId, 'usetendr.tech')).toThrow(
      /Login recovery/,
    );
  });
  it('signs exact UTF-8 payload bytes, not a hash, with the enabled recovery public key', () => {
    const kit = createNativeKit(accountId, 'usetendr.tech');
    const change = review();
    change.recoveryKey = { id: 'recovery', publicKey: nativeKitPublicKey(kit) };
    const signature = signNativeKitRecovery(kit, change, change);
    expect(
      ed25519.verify(
        Buffer.from(signature, 'base64'),
        new TextEncoder().encode(change.payload),
        bs58.decode(nativeKitPublicKey(kit).slice(8)),
      ),
    ).toBe(true);
    expect(() =>
      signNativeKitRecovery(createNativeKit(accountId, 'usetendr.tech'), change, change),
    ).toThrow(/active recovery/);
  });
  it('rejects transfers, extra fields, changed keys, different wallets and expired requests before signing', () => {
    const reviewed = review();
    expect(() => validateNativeKeyChange(reviewed, reviewed)).not.toThrow();
    for (const patch of [
      { intents: [{ intent: 'transfer', receiver_id: 'attacker' }] },
      { signer_id: 'attacker' },
      { deadline: new Date(0).toISOString() },
      { nonce: 'short' },
      { extra: 'unreviewed' },
    ]) {
      const changed = {
        ...reviewed,
        payload: JSON.stringify({ ...JSON.parse(reviewed.payload), ...patch }),
      };
      expect(() => validateNativeKeyChange(changed, changed)).toThrow(/reviewed/);
      expect(() => validateNativeKeyChange(changed, reviewed)).toThrow(/changed/);
    }
    expect(() =>
      validateNativeKeyChange(
        { ...reviewed, addedKey: { id: 'new', publicKey: 'p256:attacker' } },
        reviewed,
      ),
    ).toThrow(/changed/);
  });
  it('does not sign a chain payload through the enrollment proof method', () => {
    const kit = createNativeKit(accountId, 'usetendr.tech');
    expect(() => signNativeKitProof(kit, 'op1', review().payload)).toThrow(/proof/);
    const proof = JSON.stringify({
      purpose: 'tendr.wallet.key-possession.v1',
      operationId: 'op1',
      accountId,
      publicKey: nativeKitPublicKey(kit),
      challenge: 'a'.repeat(43),
    });
    expect(signNativeKitProof(kit, 'op1', proof)).toHaveLength(88);
  });
});
