// Asset ids (intents token ids such as `nep141:usdc.near`) and amounts. Amounts travel as strings
// in the asset's smallest unit; the dashboard shows them with the asset's decimals when it knows
// them, and always keeps the raw value one click away when it does not.

export interface AssetInfo {
  symbol: string;
  decimals: number;
  /** False when the decimals are a guess (18): the raw amount is shown too. */
  known: boolean;
}

/** Assets the dashboard knows by id. */
const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
    symbol: 'USDC',
    decimals: 6,
  },
  'nep141:usdt.tether-token.near': { symbol: 'USDT', decimals: 6 },
  'nep141:wrap.near': { symbol: 'wNEAR', decimals: 24 },
  'nep141:wrap.testnet': { symbol: 'wNEAR', decimals: 24 },
};

export const DEFAULT_DECIMALS = 18;

export function assetInfo(asset: string): AssetInfo {
  const known = KNOWN[asset];
  if (known) return { ...known, known: true };
  const lower = asset.toLowerCase();
  if (/usdc/.test(lower)) return { symbol: 'USDC', decimals: 6, known: true };
  if (/usdt/.test(lower)) return { symbol: 'USDT', decimals: 6, known: true };
  const name = asset.replace(/^nep\d+:/, '');
  return {
    symbol: name.length > 24 ? `${name.slice(0, 21)}…` : name,
    decimals: DEFAULT_DECIMALS,
    known: false,
  };
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

/** `12.5 USDC` (with `(raw 12500000)` when the decimals are a guess). */
export function formatAmount(asset: string, raw: string): string {
  const info = assetInfo(asset);
  const human = `${formatUnits(raw, info.decimals)} ${info.symbol}`;
  return info.known ? human : `${human} (raw ${raw})`;
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
  return CHAINS.find((c) => c.id === chain)?.label ?? chain;
}
