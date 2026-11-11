import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { createRecoveryKit, parseRecoveryKit } from './recovery-kit';

/** Deliberately distinct from login codes and the legacy contract-account kit. */
export interface NativeRecoveryKit {
  type: 'tendr-native-wallet-recovery';
  version: 1;
  accountId: string;
  rpId: string;
  secret: string;
}
export const encodeNativeKit = (kit: NativeRecoveryKit) => JSON.stringify(kit, null, 2);
export function createNativeKit(accountId: string, rpId: string): NativeRecoveryKit {
  const kit = createRecoveryKit();
  return {
    type: 'tendr-native-wallet-recovery',
    version: 1,
    accountId,
    rpId,
    secret: kit.secretWords,
  };
}
export function readNativeKit(text: string, accountId: string, rpId: string): NativeRecoveryKit {
  let kit: NativeRecoveryKit;
  try {
    kit = JSON.parse(text) as NativeRecoveryKit;
  } catch {
    throw new Error(
      'Paste the complete Tendr wallet recovery file. Login recovery codes cannot recover a wallet.',
    );
  }
  if (
    !kit ||
    kit.type !== 'tendr-native-wallet-recovery' ||
    kit.version !== 1 ||
    typeof kit.secret !== 'string'
  )
    throw new Error('This is not a Tendr wallet recovery kit.');
  if (kit.accountId !== accountId || kit.rpId !== rpId)
    throw new Error('This recovery kit belongs to a different wallet or Tendr domain.');
  parseRecoveryKit(kit.secret).fill(0);
  return kit;
}
function withSeed<T>(kit: NativeRecoveryKit, fn: (seed: Uint8Array) => T): T {
  const seed = parseRecoveryKit(kit.secret);
  try {
    return fn(seed);
  } finally {
    seed.fill(0);
  }
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const nativeKitPublicKey = (kit: NativeRecoveryKit) =>
  withSeed(kit, (seed) => `ed25519:${bs58.encode(ed25519.getPublicKey(seed))}`);
export const nativeKitPublicKeyB64 = (kit: NativeRecoveryKit) =>
  withSeed(kit, (seed) => base64(ed25519.getPublicKey(seed)));

/** Possession proof is domain separated and cannot itself execute as an Intents message. */
export function signNativeKitProof(
  kit: NativeRecoveryKit,
  operationId: string,
  payload: string,
): string {
  const p = JSON.parse(payload) as Record<string, unknown>;
  if (
    p.purpose !== 'tendr.wallet.key-possession.v1' ||
    p.operationId !== operationId ||
    p.accountId !== kit.accountId ||
    p.publicKey !== nativeKitPublicKey(kit) ||
    typeof p.challenge !== 'string' ||
    !/^[\w-]{43}$/.test(p.challenge)
  )
    throw new Error('The recovery kit proof does not match this wallet.');
  return withSeed(kit, (seed) => base64(ed25519.sign(new TextEncoder().encode(payload), seed)));
}

export interface KeyChangeReview {
  id: string;
  kind: string;
  accountId: string;
  contract: string;
  payload: string;
  addedKey: { id: string; publicKey: string } | null;
  removedKeys: { id: string; publicKey: string }[];
  recoveryKey?: { id: string; publicKey: string };
}
/** Never sign a transfer, another wallet, an extra action, or a silently changed review. */
export function validateNativeKeyChange(change: KeyChangeReview, reviewed: KeyChangeReview) {
  const p = JSON.parse(change.payload) as Record<string, unknown>;
  const sameKey = (a: KeyChangeReview['addedKey'], b: KeyChangeReview['addedKey']) =>
    a?.id === b?.id && a?.publicKey === b?.publicKey;
  if (
    change.id !== reviewed.id ||
    change.kind !== reviewed.kind ||
    change.accountId !== reviewed.accountId ||
    change.contract !== reviewed.contract ||
    change.payload !== reviewed.payload ||
    !sameKey(change.addedKey, reviewed.addedKey) ||
    !sameKey(change.recoveryKey ?? null, reviewed.recoveryKey ?? null) ||
    JSON.stringify(change.removedKeys.map((k) => [k.id, k.publicKey])) !==
      JSON.stringify(reviewed.removedKeys.map((k) => [k.id, k.publicKey]))
  )
    throw new Error('The wallet key change changed. Review it again before signing.');
  const expected = [
    ...(reviewed.addedKey
      ? [{ intent: 'add_public_key', public_key: reviewed.addedKey.publicKey }]
      : []),
    ...reviewed.removedKeys.map((k) => ({ intent: 'remove_public_key', public_key: k.publicKey })),
  ];
  if (
    p.signer_id !== reviewed.accountId ||
    p.verifying_contract !== reviewed.contract ||
    !['intents.near', 'intents.testnet'].includes(reviewed.contract) ||
    typeof p.deadline !== 'string' ||
    !Number.isFinite(Date.parse(p.deadline)) ||
    Date.parse(p.deadline) <= Date.now() ||
    Date.parse(p.deadline) > Date.now() + 5 * 60_000 + 5000 ||
    typeof p.nonce !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(p.nonce) ||
    Object.keys(p).sort().join() !==
      ['deadline', 'intents', 'nonce', 'signer_id', 'verifying_contract'].join() ||
    JSON.stringify(p.intents) !== JSON.stringify(expected) ||
    expected.length === 0
  )
    throw new Error('This is not the wallet key change you reviewed.');
}
export function signNativeKitRecovery(
  kit: NativeRecoveryKit,
  change: KeyChangeReview,
  reviewed: KeyChangeReview,
) {
  validateNativeKeyChange(change, reviewed);
  if (
    change.kind !== 'recover' ||
    !change.addedKey ||
    change.accountId !== kit.accountId ||
    change.recoveryKey?.publicKey !== nativeKitPublicKey(kit)
  )
    throw new Error('This kit is not the active recovery key for this wallet.');
  return withSeed(kit, (seed) =>
    base64(ed25519.sign(new TextEncoder().encode(change.payload), seed)),
  );
}
