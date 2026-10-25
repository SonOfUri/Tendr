export type Curve = 'ed25519' | 'secp256k1';

export type KeyName =
  'relayer-near' | 'relayer-evm' | 'gas-tron' | 'funding-near' | 'solver-hot' | 'relayer-accounts';

export type Signature =
  | { curve: 'ed25519'; signature: Uint8Array } // 64 bytes
  | { curve: 'secp256k1'; r: Uint8Array; s: Uint8Array; v: 0 | 1 }; // 32-byte r/s, low-s

/** Serialized envelope stored by `encrypt` (JSON string). */
export interface Envelope {
  v: 1;
  kek: string;
  wrappedDek: string; // base64
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

export interface KeyVault {
  /** Envelope-encrypts `plaintext`; `aad` is bound into the data AES-GCM. */
  encrypt(plaintext: Uint8Array, aad: string): Promise<string>;
  decrypt(envelope: string, aad: string): Promise<Uint8Array>;
  /** ed25519: signs the message; secp256k1: signs a 32-byte digest (keccak256 / sha256). */
  sign(key: KeyName, payload: Uint8Array): Promise<Signature>;
  /** ed25519: 32 bytes; secp256k1: 65 bytes uncompressed. */
  publicKey(key: KeyName): Promise<{ curve: Curve; raw: Uint8Array }>;
}
