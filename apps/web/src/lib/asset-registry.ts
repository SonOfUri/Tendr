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
