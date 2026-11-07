// Address-format checks per chain family, mirroring the API (apps/api/src/checkout/
// address-format.ts) so the shopper sees a typo before a quote is requested. Format only; the API
// checks again and is the authority.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

type ChainFamily = 'evm' | 'solana' | 'tron' | 'near' | 'bitcoin' | 'other';

const EVM = new Set([
  'eth',
  'base',
  'arb',
  'op',
  'pol',
  'bsc',
  'avax',
  'gnosis',
  'bera',
  'monad',
  'xlayer',
  'plasma',
  'scroll',
  'hood',
  'abs',
]);

export function chainFamily(blockchain: string): ChainFamily {
  const b = blockchain.toLowerCase();
  if (EVM.has(b)) return 'evm';
  if (b === 'sol' || b === 'solana') return 'solana';
  if (b === 'tron') return 'tron';
  if (b === 'near') return 'near';
  if (b === 'btc' || b === 'bitcoin') return 'bitcoin';
  return 'other';
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

function isValidEvmAddress(address: string): boolean {
  if (!EVM_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = bytesToHex(keccak_256(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const c = body[i]!;
    if (!/[a-f]/i.test(c)) continue;
    const upper = parseInt(hash[i]!, 16) >= 8;
    if (upper !== (c === c.toUpperCase())) return false;
  }
  return true;
}

const SOLANA_RE = new RegExp(`^${BASE58}{32,44}$`);
const TRON_RE = new RegExp(`^T${BASE58}{33}$`);
const NEAR_IMPLICIT_RE = /^[0-9a-f]{64}$/;
const NEAR_NAMED_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BTC_BECH32_RE = /^(bc1[02-9ac-hj-np-z]{11,71}|BC1[02-9AC-HJ-NP-Z]{11,71})$/;
const BTC_BASE58_RE = new RegExp(`^[13]${BASE58}{25,34}$`);
const OTHER_RE = /^[\x21-\x7e]{8,128}$/;

/** Whether `address` is well-formed for the network `blockchain` (a 1Click `blockchain` id). */
export function isValidAddress(blockchain: string, address: string): boolean {
  switch (chainFamily(blockchain)) {
    case 'evm':
      return isValidEvmAddress(address);
    case 'solana':
      return SOLANA_RE.test(address);
    case 'tron':
      return TRON_RE.test(address);
    case 'near':
      return (
        NEAR_IMPLICIT_RE.test(address) ||
        isValidEvmAddress(address) ||
        (address.length >= 2 && address.length <= 64 && NEAR_NAMED_RE.test(address))
      );
    case 'bitcoin':
      return BTC_BECH32_RE.test(address) || BTC_BASE58_RE.test(address);
    case 'other':
      return OTHER_RE.test(address);
  }
}
