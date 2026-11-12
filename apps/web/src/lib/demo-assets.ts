import type { Token } from '@/lib/checkout/api';
import { networkName } from '@/lib/checkout/format';
import { chainDisplayName, chainLogo, sortChainIds, type ChainLogo } from '@/lib/chain-logos';
import {
  coingeckoLogoMap,
  filterLiveOneClickTokens,
  oneClickToCheckoutToken,
  type OneClickToken,
} from '@/lib/oneclick-tokens';

/** Curated CoinMarketCap-style ids with known names (local logos under /demo/assets). */
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
  {
    cmcId: 28752,
    symbol: 'WIF',
    name: 'dogwifhat',
    logoSrc: '/demo/assets/28752.png',
    aliases: ['$WIF'],
  },
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
  const key = symbol.trim().toUpperCase();
  return BY_SYMBOL.get(key) ?? BY_SYMBOL.get(key.replace(/^\$/, ''));
}

/** One payable network for a multi-chain asset (distinct deposit address / asset id). */
export type DemoChainVariant = {
  assetId: string;
  blockchain: string;
  name: string;
  logoSrc: string;
  token: Token;
};

export type DemoAssetOption = {
  /** Checkout asset id when payable; otherwise a stable demo key. */
  value: string;
  label: string;
  /** Plain-text fallback (single chain or “N networks”). */
  detail: string;
  iconSrc: string;
  /** Overlapping network logos for multi-chain assets (USDT/USDC/…). */
  chainLogos: ChainLogo[];
  /** Full per-chain choices — Solana USDC ≠ Ethereum USDC. */
  chainVariants: DemoChainVariant[];
  disabled?: boolean;
  token?: Token;
};

/** Max overlapping logos before a +N chip. */
export const DEMO_CHAIN_STACK_MAX = 6;

/** Whether this option has more networks than the stacked logos show. */
export function hasChainOverflow(option: DemoAssetOption): boolean {
  return option.chainVariants.length > DEMO_CHAIN_STACK_MAX;
}

/** Any asset on 2+ rails needs an explicit network pick (addresses differ per chain). */
export function isMultiChain(option: DemoAssetOption): boolean {
  return option.chainVariants.length > 1;
}

export function optionMatchesAssetId(option: DemoAssetOption, assetId: string): boolean {
  if (option.value === assetId) return true;
  return option.chainVariants.some((v) => v.assetId === assetId);
}

export function variantForAssetId(
  option: DemoAssetOption,
  assetId: string,
): DemoChainVariant | undefined {
  return option.chainVariants.find((v) => v.assetId === assetId);
}

/** Prefer each asset’s home rail (BTC→btc, ETH→eth) over bridged copies on NEAR/etc. */
const PREFERRED_CHAIN: Readonly<Record<string, number>> = {
  eth: 0,
  btc: 1,
  sol: 2,
  base: 3,
  arb: 4,
  bsc: 5,
  op: 6,
  pol: 7,
  avax: 8,
  tron: 9,
  ton: 10,
  near: 20,
};

const NATIVE_CHAIN: Readonly<Record<string, string>> = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  BNB: 'bsc',
  AVAX: 'avax',
  NEAR: 'near',
  WNEAR: 'near',
  TRX: 'tron',
  XRP: 'xrp',
  DOGE: 'doge',
  LTC: 'ltc',
  BCH: 'bch',
  ADA: 'cardano',
  SUI: 'sui',
  TON: 'ton',
  XLM: 'stellar',
  ZEC: 'zec',
  DASH: 'dash',
};

function groupKey(symbol: string): string {
  const meta = demoAssetMeta(symbol);
  const raw = (meta?.symbol ?? symbol).trim().toUpperCase().replace(/^\$/, '');
  return raw;
}

function tokenLogoSrc(token: Token): string {
  const meta = demoAssetMeta(token.symbol);
  if (meta) return meta.logoSrc;
  if (token.logo_url) return token.logo_url;
  const cg = token.coingecko_id?.trim();
  if (cg) {
    const fromMap = coingeckoLogoMap().get(cg);
    if (fromMap) return fromMap;
  }
  const sym = token.symbol.trim().toLowerCase().replace(/^\$/, '');
  // Last-resort free CDN — many long-tail symbols 404; UI shows a letter avatar.
  return `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${sym}.png`;
}

function pickPrimary(tokens: Token[]): Token {
  return [...tokens].sort((a, b) => {
    const sym = groupKey(a.symbol);
    const home = NATIVE_CHAIN[sym];
    if (home) {
      const aHome = a.blockchain.toLowerCase() === home ? 0 : 1;
      const bHome = b.blockchain.toLowerCase() === home ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
    }
    if (a.popular !== b.popular) return a.popular ? -1 : 1;
    const ai = PREFERRED_CHAIN[a.blockchain.toLowerCase()] ?? 40;
    const bi = PREFERRED_CHAIN[b.blockchain.toLowerCase()] ?? 40;
    if (ai !== bi) return ai - bi;
    return a.asset_id.localeCompare(b.asset_id);
  })[0]!;
}

function optionFromGroup(tokens: Token[], testnet: boolean): DemoAssetOption {
  const primary = pickPrimary(tokens);
  const meta = demoAssetMeta(primary.symbol);
  const byChain = new Map<string, Token>();
  for (const t of tokens) {
    const id = t.blockchain.toLowerCase();
    if (!byChain.has(id)) byChain.set(id, t);
  }
  const chains = sortChainIds([...byChain.keys()]);
  const chainVariants = chains.map((id) => {
    const token = byChain.get(id)!;
    const logo = chainLogo(id);
    return {
      assetId: token.asset_id,
      blockchain: id,
      name: testnet ? networkName(id, true) : logo.name || chainDisplayName(id),
      logoSrc: logo.logoSrc,
      token,
    };
  });
  const chainLogos = chainVariants
    .filter((v) => v.logoSrc)
    .map((v) => ({ id: v.blockchain, name: v.name, logoSrc: v.logoSrc }));
  const withLogo = tokens.find((t) => t.logo_url) ?? primary;
  const label = meta ? `${meta.name} (${meta.symbol})` : primary.symbol.replace(/^\$/, '');
  const detail =
    chains.length === 1
      ? testnet
        ? networkName(chains[0]!, true)
        : chainDisplayName(chains[0]!)
      : `${chains.length} networks`;

  return {
    value: primary.asset_id,
    label,
    detail,
    iconSrc: tokenLogoSrc({ ...withLogo, symbol: meta?.symbol ?? withLogo.symbol }),
    chainLogos,
    chainVariants,
    token: primary,
  };
}

/**
 * Build the Asset dropdown from the checkout token catalog, with explicit Tidepool network names.
 * Same symbol across chains collapses to one row with overlapping network logos.
 */
export function buildDemoAssetOptions(apiTokens: Token[], testnet = false): DemoAssetOption[] {
  const groups = new Map<string, Token[]>();
  const usedAssetIds = new Set<string>();

  for (const token of apiTokens) {
    if (usedAssetIds.has(token.asset_id)) continue;
    usedAssetIds.add(token.asset_id);
    const key = groupKey(token.symbol);
    const list = groups.get(key) ?? [];
    // One row per symbol+chain inside the group (duplicate contracts on same chain → keep first).
    if (list.some((t) => t.blockchain.toLowerCase() === token.blockchain.toLowerCase())) continue;
    list.push(token);
    groups.set(key, list);
  }

  const options = [...groups.values()].map((tokens) => optionFromGroup(tokens, testnet));

  options.sort((a, b) => {
    const aMeta = demoAssetMeta(a.token?.symbol ?? '');
    const bMeta = demoAssetMeta(b.token?.symbol ?? '');
    const ai = aMeta ? DEMO_KNOWN_ASSETS.findIndex((x) => x.cmcId === aMeta.cmcId) : 999;
    const bi = bMeta ? DEMO_KNOWN_ASSETS.findIndex((x) => x.cmcId === bMeta.cmcId) : 999;
    if (ai !== bi) return ai - bi;
    const ap = a.token?.popular ? 0 : 1;
    const bp = b.token?.popular ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.label.localeCompare(b.label);
  });

  return options;
}

/** Convert a live 1Click payload into checkout tokens for the demo. */
export function tokensFromOneClick(rows: readonly OneClickToken[]): Token[] {
  const logos = coingeckoLogoMap();
  return filterLiveOneClickTokens(rows).map((row) => oneClickToCheckoutToken(row, logos));
}

/** Tokens the shopper can actually quote / pay with. */
export function payableDemoTokens(apiTokens: Token[]): Token[] {
  return buildDemoAssetOptions(apiTokens)
    .filter((o) => o.token)
    .map((o) => o.token!);
}
