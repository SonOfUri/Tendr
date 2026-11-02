// Asset ids (intents token ids such as `nep141:usdt.tether-token.near`) and amounts. Amounts
// travel as strings in the asset's smallest unit. The dashboard converts to a human amount ONLY
// for the exact asset ids in the registry (asset-registry.ts) of the account's mode; every other
// asset is shown and entered in raw smallest units next to its full id, never with guessed
// decimals or a guessed symbol.
import { registeredAsset } from './asset-registry';

export interface AssetInfo {
  /** The registry symbol, or the full asset id when the asset is not in the registry. */
  symbol: string;
  /** The registry decimals; 0 (raw smallest units) when the asset is not in the registry. */
  decimals: number;
  known: boolean;
}

export function assetInfo(asset: string, livemode: boolean): AssetInfo {
  const known = registeredAsset(asset, livemode);
  if (known) return { symbol: known.symbol, decimals: known.decimals, known: true };
  return { symbol: asset, decimals: 0, known: false };
}

const DIGITS = /^(0|[1-9]\d*)$/;

/** `raw` (smallest units) as a decimal string with `decimals` places, trailing zeros trimmed. */
export function formatUnits(raw: string, decimals: number): string {
  if (!DIGITS.test(raw)) return raw;
  if (decimals === 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** A human amount (`12.5`) in smallest units, or null when it is not a valid amount. */
export function parseUnits(human: string, decimals: number): string | null {
  const v = human.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(v);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const raw = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return raw;
}

/**
 * `12.5 USDC` for a registered asset; otherwise the raw amount and the full asset id
 * (`12500000 smallest units of nep141:x.near`).
 */
export function formatAmount(asset: string, raw: string, livemode: boolean): string {
  const info = assetInfo(asset, livemode);
  return info.known
    ? `${formatUnits(raw, info.decimals)} ${info.symbol}`
    : `${raw} smallest units of ${asset}`;
}

/**
 * The NEP-141 token contract of a PoA (same-token) withdrawal: the asset's own contract. Null for
 * assets that are not NEP-141 tokens (they cannot be withdrawn as the same token from here).
 */
export function poaTokenContract(asset: string): string | null {
  const m = /^nep141:([a-z0-9._-]{2,64})$/.exec(asset);
  return m ? m[1]! : null;
}

/** Chains a saved address can be on (the API's SUPPORTED_CHAINS). */
export const CHAINS: { id: string; label: string }[] = [
  { id: 'near', label: 'NEAR' },
  { id: 'eth', label: 'Ethereum' },
  { id: 'base', label: 'Base' },
  { id: 'arbitrum', label: 'Arbitrum' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'bsc', label: 'BNB Chain' },
  { id: 'optimism', label: 'Optimism' },
  { id: 'avalanche', label: 'Avalanche' },
  { id: 'sol', label: 'Solana' },
  { id: 'tron', label: 'Tron' },
  { id: 'btc', label: 'Bitcoin' },
];

export function chainLabel(chain: string): string {
  const aliases: Record<string, string> = {
    arb: 'arbitrum',
    pol: 'polygon',
    op: 'optimism',
    avax: 'avalanche',
    solana: 'sol',
    bitcoin: 'btc',
  };
  return CHAINS.find((c) => c.id === (aliases[chain] ?? chain))?.label ?? chain;
}
