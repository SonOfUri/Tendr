import type { Token } from '@/lib/checkout/api';

/** Curated CoinMarketCap-style ids with known names (unconfirmed logos skipped). */
export type DemoAssetMeta = {
  cmcId: number;
  symbol: string;
  name: string;
  logoSrc: string;
  /** Extra API symbols that should map to this asset (e.g. wNEAR → NEAR). */
  aliases?: readonly string[];
};

export const DEMO_KNOWN_ASSETS: readonly DemoAssetMeta[] = [
  { cmcId: 1, symbol: 'BTC', name: 'Bitcoin', logoSrc: '/demo/assets/1.png' },
  { cmcId: 2, symbol: 'LTC', name: 'Litecoin', logoSrc: '/demo/assets/2.png' },
  { cmcId: 52, symbol: 'XRP', name: 'XRP', logoSrc: '/demo/assets/52.png' },
  { cmcId: 74, symbol: 'DOGE', name: 'Dogecoin', logoSrc: '/demo/assets/74.png' },
  { cmcId: 131, symbol: 'DASH', name: 'Dash', logoSrc: '/demo/assets/131.png' },
  { cmcId: 512, symbol: 'XLM', name: 'Stellar', logoSrc: '/demo/assets/512.png' },
  { cmcId: 825, symbol: 'USDT', name: 'Tether', logoSrc: '/demo/assets/825.png' },
  { cmcId: 1027, symbol: 'ETH', name: 'Ethereum', logoSrc: '/demo/assets/1027.png' },
  { cmcId: 1437, symbol: 'ZEC', name: 'Zcash', logoSrc: '/demo/assets/1437.png' },
  { cmcId: 1831, symbol: 'BCH', name: 'Bitcoin Cash', logoSrc: '/demo/assets/1831.png' },
  { cmcId: 1839, symbol: 'BNB', name: 'BNB', logoSrc: '/demo/assets/1839.png' },
  { cmcId: 3408, symbol: 'USDC', name: 'USD Coin', logoSrc: '/demo/assets/3408.png' },
  { cmcId: 3897, symbol: 'OKB', name: 'OKB', logoSrc: '/demo/assets/3897.png' },
  { cmcId: 4943, symbol: 'DAI', name: 'Dai', logoSrc: '/demo/assets/4943.png' },
  { cmcId: 5426, symbol: 'SOL', name: 'Solana', logoSrc: '/demo/assets/5426.png' },
  { cmcId: 5805, symbol: 'AVAX', name: 'Avalanche', logoSrc: '/demo/assets/5805.png' },
  { cmcId: 5994, symbol: 'SHIB', name: 'Shiba Inu', logoSrc: '/demo/assets/5994.png' },
  {
    cmcId: 6535,
    symbol: 'NEAR',
    name: 'NEAR Protocol',
    logoSrc: '/demo/assets/6535.png',
    aliases: ['wNEAR', 'WNEAR'],
  },
  { cmcId: 7083, symbol: 'UNI', name: 'Uniswap', logoSrc: '/demo/assets/7083.png' },
  { cmcId: 7278, symbol: 'AAVE', name: 'Aave', logoSrc: '/demo/assets/7278.png' },
  { cmcId: 8567, symbol: 'BABYDOGE', name: 'Baby Doge Coin', logoSrc: '/demo/assets/8567.png' },
  { cmcId: 11840, symbol: 'OP', name: 'Optimism', logoSrc: '/demo/assets/11840.png' },
  { cmcId: 11841, symbol: 'ARB', name: 'Arbitrum', logoSrc: '/demo/assets/11841.png' },
  { cmcId: 14803, symbol: 'ASTR', name: 'Astar', logoSrc: '/demo/assets/14803.png' },
  { cmcId: 19354, symbol: 'APE', name: 'ApeCoin', logoSrc: '/demo/assets/19354.png' },
  { cmcId: 20947, symbol: 'SUI', name: 'Sui', logoSrc: '/demo/assets/20947.png' },
  { cmcId: 21585, symbol: 'CELO', name: 'Celo', logoSrc: '/demo/assets/21585.png' },
  { cmcId: 22691, symbol: 'SEI', name: 'Sei', logoSrc: '/demo/assets/22691.png' },
  { cmcId: 24478, symbol: 'PEPE', name: 'Pepe', logoSrc: '/demo/assets/24478.png' },
  { cmcId: 28752, symbol: 'WIF', name: 'dogwifhat', logoSrc: '/demo/assets/28752.png' },
  { cmcId: 34466, symbol: 'PENGU', name: 'Pudgy Penguins', logoSrc: '/demo/assets/34466.png' },
  { cmcId: 35347, symbol: 'MELANIA', name: 'Melania Meme', logoSrc: '/demo/assets/35347.png' },
] as const;

const BY_SYMBOL = new Map<string, DemoAssetMeta>();
for (const asset of DEMO_KNOWN_ASSETS) {
  BY_SYMBOL.set(asset.symbol.toUpperCase(), asset);
  for (const alias of asset.aliases ?? []) {
    BY_SYMBOL.set(alias.toUpperCase(), asset);
  }
}

export function demoAssetMeta(symbol: string): DemoAssetMeta | undefined {
  return BY_SYMBOL.get(symbol.trim().toUpperCase());
}

export type DemoAssetOption = {
  /** Checkout asset id when payable; otherwise a stable demo key. */
  value: string;
  label: string;
  detail: string;
  iconSrc: string;
  disabled?: boolean;
  token?: Token;
};

function networkLabel(blockchain: string): string {
  const b = blockchain.toLowerCase();
  if (b === 'eth' || b === 'ethereum') return 'Ethereum';
  if (b === 'btc' || b === 'bitcoin') return 'Bitcoin';
  if (b === 'sol' || b === 'solana') return 'Solana';
  if (b === 'base') return 'Base';
  if (b === 'near') return 'NEAR';
  return blockchain;
}

/**
 * Build the Asset dropdown from the curated logo list.
 * Payable rows are API tokens that match a known symbol (or alias).
 * Remaining known assets still appear (with logos) but are disabled until the API lists them.
 */
export function buildDemoAssetOptions(apiTokens: Token[]): DemoAssetOption[] {
  const usedAssetIds = new Set<string>();
  const options: DemoAssetOption[] = [];

  // Payable matches first — one row per API token that maps to a known asset.
  const payable = apiTokens
    .map((token) => {
      const meta = demoAssetMeta(token.symbol);
      if (!meta) return null;
      return { token, meta };
    })
    .filter((row): row is { token: Token; meta: DemoAssetMeta } => row !== null)
    .sort((a, b) => {
      const ai = DEMO_KNOWN_ASSETS.findIndex((x) => x.cmcId === a.meta.cmcId);
      const bi = DEMO_KNOWN_ASSETS.findIndex((x) => x.cmcId === b.meta.cmcId);
      if (ai !== bi) return ai - bi;
      if (a.token.popular !== b.token.popular) return a.token.popular ? -1 : 1;
      return a.token.blockchain.localeCompare(b.token.blockchain);
    });

  const usedSymbolChain = new Set<string>();
  for (const { token, meta } of payable) {
    if (usedAssetIds.has(token.asset_id)) continue;
    const chainKey = `${meta.symbol.toUpperCase()}::${token.blockchain.toLowerCase()}`;
    // API can return multiple contracts for the same asset+network — keep one row.
    if (usedSymbolChain.has(chainKey)) continue;
    usedSymbolChain.add(chainKey);
    usedAssetIds.add(token.asset_id);
    options.push({
      value: token.asset_id,
      label: `${meta.name} (${token.symbol})`,
      detail: networkLabel(token.blockchain),
      iconSrc: meta.logoSrc,
      token,
    });
  }

  const coveredSymbols = new Set(
    payable.map(({ meta }) => meta.symbol.toUpperCase()),
  );

  // Show the rest of the curated catalog so logos are visible even when not quoteable yet.
  for (const meta of DEMO_KNOWN_ASSETS) {
    if (coveredSymbols.has(meta.symbol.toUpperCase())) continue;
    options.push({
      value: `demo:${meta.cmcId}`,
      label: `${meta.name} (${meta.symbol})`,
      detail: 'Coming soon',
      iconSrc: meta.logoSrc,
      disabled: true,
    });
  }

  // Any other API tokens (e.g. ETH, USDT) stay selectable even without a curated logo.
  for (const token of apiTokens) {
    if (usedAssetIds.has(token.asset_id)) continue;
    if (demoAssetMeta(token.symbol)) continue;
    usedAssetIds.add(token.asset_id);
    options.push({
      value: token.asset_id,
      label: token.symbol,
      detail: networkLabel(token.blockchain),
      iconSrc: '',
      token,
    });
  }

  return options;
}

/** Tokens the shopper can actually quote / pay with. */
export function payableDemoTokens(apiTokens: Token[]): Token[] {
  return buildDemoAssetOptions(apiTokens)
    .filter((o) => o.token)
    .map((o) => o.token!);
}
