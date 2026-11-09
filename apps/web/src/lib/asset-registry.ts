// The assets the dashboard knows, by EXACT intents token id and mode. Only these get a symbol and
// human-readable amounts; anything else is shown and entered in raw smallest units with its full
// id (assets.ts). Add an asset here only with its verified on-chain decimals.

export interface RegisteredAsset {
  symbol: string;
  decimals: number;
}

const LIVE: Readonly<Record<string, RegisteredAsset>> = {
  // Native USDC on NEAR (Circle).
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
    symbol: 'USDC',
    decimals: 6,
  },
  'nep141:usdt.tether-token.near': { symbol: 'USDT', decimals: 6 },
  'nep141:wrap.near': { symbol: 'wNEAR', decimals: 24 },
  // Bridged natives / stables (1Click omft) — common checkout origin assets.
  'nep141:base.omft.near': { symbol: 'ETH', decimals: 18 },
  'nep141:eth.omft.near': { symbol: 'ETH', decimals: 18 },
  'nep141:arb.omft.near': { symbol: 'ETH', decimals: 18 },
  'nep141:op.omft.near': { symbol: 'ETH', decimals: 18 },
  'nep141:bsc.omft.near': { symbol: 'BNB', decimals: 18 },
  'nep141:avax.omft.near': { symbol: 'AVAX', decimals: 18 },
  'nep141:pol.omft.near': { symbol: 'POL', decimals: 18 },
  'nep141:sol.omft.near': { symbol: 'SOL', decimals: 9 },
  'nep141:btc.omft.near': { symbol: 'BTC', decimals: 8 },
  'nep141:tron.omft.near': { symbol: 'TRX', decimals: 6 },
  'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': {
    symbol: 'USDC',
    decimals: 6,
  },
  'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': {
    symbol: 'USDC',
    decimals: 6,
  },
  'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near': {
    symbol: 'USDT',
    decimals: 6,
  },
};
const TEST: Readonly<Record<string, RegisteredAsset>> = {
  // Testnet stand-ins used with the mock intents verifier (and the dashboard e2e).
  'nep141:usdc.fakes.testnet': { symbol: 'USDC', decimals: 6 },
  'nep141:wrap.testnet': { symbol: 'wNEAR', decimals: 24 },
};

/** The registry entry of `asset` in this mode, or null. */
export function registeredAsset(asset: string, livemode: boolean): RegisteredAsset | null {
  const table = livemode ? LIVE : TEST;
  return Object.hasOwn(table, asset) ? table[asset]! : null;
}

/** Registered asset ids of a mode (suggestions in asset fields). */
export function registeredAssetIds(livemode: boolean): string[] {
  return Object.keys(livemode ? LIVE : TEST);
}
