/** Map 1Click `blockchain` ids → display name + logo URL (Trust Wallet → Llama → coin fallback). */

const TW = 'https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains';
const LLAMA = 'https://icons.llamao.fi/icons/chains/rsz_';

type ChainMeta = {
  name: string;
  /** Trust Wallet folder key when it exists. */
  twKey?: string;
  /** DefiLlama icons.llamao.fi chain key when TW is missing. */
  llamaKey?: string;
  /** Last-resort direct image URL. */
  fallbackSrc?: string;
};

const CHAINS: Readonly<Record<string, ChainMeta>> = {
  eth: { name: 'Ethereum', twKey: 'ethereum' },
  base: { name: 'Base', twKey: 'base' },
  arb: { name: 'Arbitrum', twKey: 'arbitrum' },
  op: { name: 'Optimism', twKey: 'optimism' },
  pol: { name: 'Polygon', twKey: 'polygon' },
  bsc: { name: 'BNB Chain', twKey: 'smartchain' },
  avax: { name: 'Avalanche', twKey: 'avalanchec' },
  gnosis: { name: 'Gnosis', twKey: 'xdai', llamaKey: 'gnosis' },
  bera: { name: 'Berachain', llamaKey: 'berachain' },
  sol: { name: 'Solana', twKey: 'solana' },
  tron: { name: 'Tron', twKey: 'tron' },
  btc: { name: 'Bitcoin', twKey: 'bitcoin' },
  near: { name: 'NEAR', twKey: 'near' },
  ton: { name: 'TON', twKey: 'ton' },
  doge: { name: 'Dogecoin', twKey: 'doge', llamaKey: 'dogecoin' },
  xrp: { name: 'XRP', twKey: 'ripple', llamaKey: 'ripple' },
  zec: { name: 'Zcash', twKey: 'zcash' },
  sui: { name: 'Sui', twKey: 'sui' },
  aptos: { name: 'Aptos', twKey: 'aptos' },
  stellar: { name: 'Stellar', twKey: 'stellar' },
  cardano: { name: 'Cardano', twKey: 'cardano' },
  ltc: { name: 'Litecoin', twKey: 'litecoin' },
  bch: { name: 'Bitcoin Cash', twKey: 'bitcoincash' },
  dash: { name: 'Dash', twKey: 'dash' },
  aleo: { name: 'Aleo', llamaKey: 'aleo' },
  monad: { name: 'Monad', twKey: 'monad', llamaKey: 'monad' },
  plasma: { name: 'Plasma', twKey: 'plasma', llamaKey: 'plasma' },
  scroll: { name: 'Scroll', twKey: 'scroll', llamaKey: 'scroll' },
  starknet: {
    name: 'Starknet',
    // TW / Llama lack a stable starknet chain icon — use the STRK asset image.
    fallbackSrc: 'https://assets.coingecko.com/coins/images/26433/small/starknet.png',
  },
  aurora: { name: 'Aurora', twKey: 'aurora' },
  xlayer: { name: 'X Layer', twKey: 'okx', llamaKey: 'okx' },
  adi: {
    name: 'ADI',
    fallbackSrc: 'https://assets.coingecko.com/coins/images/68846/small/ADI_Token-min.png',
  },
  abs: { name: 'Abstract', llamaKey: 'abstract' },
  hood: { name: 'HyperEVM', twKey: 'hyperevm', llamaKey: 'hyperevm' },
  hypercore: { name: 'Hyperliquid', llamaKey: 'hyperliquid' },
  movement: { name: 'Movement', llamaKey: 'movement' },
  fogo: { name: 'Fogo', llamaKey: 'fogo' },
};

export type ChainLogo = {
  id: string;
  name: string;
  logoSrc: string;
};

/** Contract names and common aliases → the 1Click `blockchain` id the logo table uses. */
const CHAIN_ALIAS: Readonly<Record<string, string>> = {
  arbitrum: 'arb',
  polygon: 'pol',
  matic: 'pol',
  optimism: 'op',
  avalanche: 'avax',
  ethereum: 'eth',
  solana: 'sol',
  bitcoin: 'btc',
};

/** The 1Click id for a chain name (`arbitrum` and `arb` are both `arb`). */
export function chainId(blockchain: string): string {
  const id = blockchain.toLowerCase();
  return CHAIN_ALIAS[id] ?? id;
}

export function chainDisplayName(blockchain: string): string {
  const id = chainId(blockchain);
  return CHAINS[id]?.name ?? blockchain.toUpperCase();
}

export function chainLogo(blockchain: string): ChainLogo {
  const id = chainId(blockchain);
  const meta = CHAINS[id];
  let logoSrc = '';
  if (meta?.twKey) logoSrc = `${TW}/${meta.twKey}/info/logo.png`;
  else if (meta?.llamaKey) logoSrc = `${LLAMA}${meta.llamaKey}.jpg`;
  else if (meta?.fallbackSrc) logoSrc = meta.fallbackSrc;

  return {
    id,
    name: meta?.name ?? blockchain.toUpperCase(),
    logoSrc,
  };
}

/** Prefer familiar rails first when stacking overlapping logos. */
const CHAIN_SORT: Readonly<Record<string, number>> = {
  eth: 0,
  btc: 1,
  sol: 2,
  base: 3,
  arb: 4,
  near: 5,
  bsc: 6,
  op: 7,
  pol: 8,
  avax: 9,
  tron: 10,
  ton: 11,
};

export function sortChainIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const ai = CHAIN_SORT[a.toLowerCase()] ?? 50;
    const bi = CHAIN_SORT[b.toLowerCase()] ?? 50;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}
