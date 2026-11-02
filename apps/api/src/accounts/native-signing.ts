// Native NEAR Intents WebAuthn encoding. A store wallet has its own P256 credential.
import { createHash, randomBytes } from 'node:crypto';
import { p256 } from '@noble/curves/p256';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import { z } from 'zod';
import { normalizeP256Signature } from './encoding.js';

export const payloadChallenge = (payload: string) =>
  createHash('sha256').update(payload).digest().toString('base64url');

export function nativePublicKey(compressedBase64: string): string {
  const raw = p256.ProjectivePoint.fromHex(Buffer.from(compressedBase64, 'base64')).toRawBytes(
    false,
  );
  return `p256:${bs58.encode(raw.slice(1))}`;
}

export function nativeAccountId(publicKey: string): string {
  if (!publicKey.startsWith('p256:')) throw new Error('Native wallets require P256');
  const raw = bs58.decode(publicKey.slice(5));
  if (raw.length !== 64) throw new Error('Invalid P256 public key');
  // The verifier domain-separates P256 from Ethereum/secp256k1 accounts.
  return `0x${Buffer.from(keccak_256(Buffer.concat([Buffer.from('p256'), raw])))
    .subarray(12)
    .toString('hex')}`;
}

export function activationPayload(accountId: string, contract: string, expires: Date): string {
  return JSON.stringify({
    signer_id: accountId,
    verifying_contract: contract,
    deadline: expires.toISOString(),
    nonce: randomBytes(32).toString('base64'),
    intents: [],
  });
}

export interface NativeSignedIntent {
  standard: 'webauthn';
  payload: string;
  public_key: string;
  signature: string;
  client_data_json: string;
  authenticator_data: string;
}

/** Call only AFTER verifying RP ID, origin, challenge, UV and signature with SimpleWebAuthn. */
export function signedIntent(
  payload: string,
  publicKey: string,
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  },
): NativeSignedIntent {
  return {
    standard: 'webauthn',
    payload,
    public_key: publicKey,
    signature: `p256:${bs58.encode(normalizeP256Signature(Buffer.from(response.signature, 'base64url')))}`,
    client_data_json: Buffer.from(response.clientDataJSON, 'base64url').toString('utf8'),
    authenticator_data: Buffer.from(response.authenticatorData, 'base64url').toString('base64url'),
  };
}

const TransferPayload = z
  .object({
    signer_id: z.string(),
    verifying_contract: z.string(),
    deadline: z.string().datetime(),
    nonce: z
      .string()
      .refine((s) => /^[A-Za-z0-9+/]{43}=$/.test(s) && Buffer.from(s, 'base64').length === 32),
    intents: z.tuple([
      z
        .object({
          intent: z.literal('transfer'),
          receiver_id: z.string(),
          tokens: z.record(z.string()),
        })
        .strict(),
    ]),
  })
  .strict();

/** Never ask a merchant to sign unchecked provider JSON (key changes, extra debits, etc.). */
export function validateTransferPayload(
  payload: string,
  expected: {
    signerId: string;
    contract: string;
    depositAddress: string;
    asset: string;
    amount: string;
  },
): Date {
  const p = TransferPayload.parse(JSON.parse(payload));
  const transfer = p.intents[0];
  const deadline = new Date(p.deadline);
  if (
    p.signer_id !== expected.signerId ||
    p.verifying_contract !== expected.contract ||
    transfer.receiver_id !== expected.depositAddress ||
    Object.keys(transfer.tokens).length !== 1 ||
    transfer.tokens[expected.asset] !== expected.amount ||
    deadline.getTime() <= Date.now() ||
    deadline.getTime() > Date.now() + 4 * 86_400_000
  ) {
    throw new Error('1Click intent does not match the requested payout');
  }
  return deadline;
}
