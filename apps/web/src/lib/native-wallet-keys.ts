import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, type StoreContext } from './api';
import { withStepUp } from './webauthn';
import {
  nativeKitPublicKeyB64,
  signNativeKitProof,
  signNativeKitRecovery,
  validateNativeKeyChange,
  type KeyChangeReview,
  type NativeRecoveryKit,
} from './native-wallet-recovery';

export interface WalletKey {
  id: string;
  kind: string;
  label: string;
  status: string;
  publicKey: string;
  createdAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}
export interface KeyOperation {
  id: string;
  kind: string;
  label: string;
  status: string;
  candidateKeyId: string | null;
  recoveryKeyId: string | null;
  revokeKeyIds: string[];
  expiresAt: string;
  intentHash: string | null;
  canCancel: boolean;
  registrationOptions?: PublicKeyCredentialCreationOptionsJSON;
  proofOptions?: PublicKeyCredentialRequestOptionsJSON;
  proofPayload?: string;
}
export interface WalletKeyState {
  accountId: string;
  rpId: string;
  contract: string;
  keys: WalletKey[];
  operations: KeyOperation[];
}
export interface WalletKeyChallenge extends KeyOperation, KeyChangeReview {
  addedKey: WalletKey | null;
  removedKeys: WalletKey[];
  recoveryKey?: WalletKey;
  options?: PublicKeyCredentialRequestOptionsJSON;
}
const base = '/v1/account/native/keys';
const path = (id: string) => `${base}/operations/${encodeURIComponent(id)}`;
const post = <T>(store: StoreContext, url: string, json: object = {}) =>
  withStepUp(() => api<T>(url, { method: 'POST', json, store }));
export const walletKeys = (store: StoreContext) => api<WalletKeyState>(base, { store });
export const cancelKeyOperation = (store: StoreContext, id: string) =>
  post<KeyOperation>(store, `${path(id)}/cancel`);
export const reviewKeyOperation = (store: StoreContext, id: string) =>
  post<WalletKeyChallenge>(store, `${path(id)}/challenge`);
export const getKeyOperation = (store: StoreContext, id: string) =>
  withStepUp(() => api<KeyOperation>(path(id), { store }));

export async function continueKeyRegistration(store: StoreContext, op: KeyOperation) {
  if (op.status === 'registering' && op.registrationOptions) {
    const response = await startRegistration({ optionsJSON: op.registrationOptions });
    op = await post<KeyOperation>(store, `${path(op.id)}/register`, { response });
  }
  if (op.status === 'proving' && op.proofOptions) {
    const response = await startAuthentication({ optionsJSON: op.proofOptions });
    op = await post<KeyOperation>(store, `${path(op.id)}/prove`, { response });
  }
  return op;
}
export async function addWalletPasskey(store: StoreContext, label: string, recoveryKeyId?: string) {
  const op = await post<KeyOperation>(
    store,
    `${base}/operations`,
    recoveryKeyId ? { kind: 'recover', label, recoveryKeyId } : { kind: 'add_passkey', label },
  );
  return continueKeyRegistration(store, op);
}
export async function proveWalletKit(
  store: StoreContext,
  op: KeyOperation,
  kit: NativeRecoveryKit,
) {
  if (!op.proofPayload) throw new Error('This kit is no longer waiting for a possession proof.');
  return post<KeyOperation>(store, `${path(op.id)}/prove`, {
    signatureB64: signNativeKitProof(kit, op.id, op.proofPayload),
  });
}
export async function enrollWalletKit(store: StoreContext, kit: NativeRecoveryKit) {
  const op = await post<KeyOperation>(store, `${base}/operations`, {
    kind: 'add_recovery',
    label: 'Offline recovery kit',
    publicKeyB64: nativeKitPublicKeyB64(kit),
    saved: true,
  });
  return proveWalletKit(store, op, kit);
}
export const revokeWalletKey = (store: StoreContext, keyId: string) =>
  post<KeyOperation>(store, `${base}/operations`, { kind: 'revoke', keyId });
export async function approveWalletKeyChange(
  store: StoreContext,
  reviewed: WalletKeyChallenge,
  kit?: NativeRecoveryKit,
) {
  const current = await reviewKeyOperation(store, reviewed.id);
  validateNativeKeyChange(current, reviewed);
  if (current.kind === 'recover') {
    if (!kit) throw new Error('Paste your saved wallet recovery kit first.');
    return post<KeyOperation>(store, `${path(current.id)}/submit`, {
      signatureB64: signNativeKitRecovery(kit, current, reviewed),
    });
  }
  if (!current.options) throw new Error('A registered wallet passkey is required.');
  const response = await startAuthentication({ optionsJSON: current.options });
  return post<KeyOperation>(store, `${path(current.id)}/submit`, { response });
}
