import bs58 from 'bs58';
import type { Curve, KeyName } from './types.js';

/**
 * Every signing key the platform uses. EVM and Solana gas sponsorship go through Pimlico,
 * whose API key is a stored secret (`putSecret`, purpose `pimlico`), not a signing key.
 */
const REGISTRY: Record<KeyName, Curve> = {
  'relayer-near': 'ed25519', // notify-only relayer on NEAR
  'relayer-evm': 'secp256k1', // notify-only relayer on EVM; also submits EIP-3009 transfers
  'gas-tron': 'secp256k1', // Tron gas wallet (energy/bandwidth sponsorship)
  'funding-near': 'ed25519', // pays storage deposits for merchant NEAR accounts (spend-capped)
  'solver-hot': 'ed25519', // phase 2
  'relayer-accounts': 'ed25519', // gas-only relayer for merchant account contracts; never a signer
};

export const KEY_NAMES = Object.keys(REGISTRY) as KeyName[];

export function curveOf(key: KeyName): Curve {
  const curve = REGISTRY[key];
  if (!curve) throw new Error(`Unknown key name: ${String(key)}`);
  return curve;
}

/** NEAR public-key string: `ed25519:` + base58 of the 32-byte key. */
export function nearPublicKey(raw32: Uint8Array): string {
  if (raw32.length !== 32) throw new Error('Expected a 32-byte ed25519 public key');
  return 'ed25519:' + bs58.encode(raw32);
}
