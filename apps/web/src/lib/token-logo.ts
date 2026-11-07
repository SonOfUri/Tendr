/** Dextools chain slug for a 1Click chain id. Chains not listed here are not queried. */
const DEXTOOLS_CHAIN: Record<string, string> = {
  eth: 'ether',
  ethereum: 'ether',
  bsc: 'bnb',
  bnb: 'bnb',
  pol: 'polygon',
  polygon: 'polygon',
  matic: 'polygon',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  op: 'optimism',
  optimism: 'optimism',
  avax: 'avalanche',
  avalanche: 'avalanche',
  base: 'base',
  sol: 'solana',
  solana: 'solana',
  near: 'near',
  tron: 'tron',
  ton: 'ton',
  sui: 'sui',
  aptos: 'aptos',
  gnosis: 'gnosis',
  starknet: 'starknet',
  scroll: 'scroll',
  bera: 'berachain',
  berachain: 'berachain',
  monad: 'monad',
  xlayer: 'xlayer',
  plasma: 'plasma',
  abs: 'abstract',
  abstract: 'abstract',
};

export interface DextoolsToken {
  chain: string;
  address: string;
}

/**
 * The Dextools chain and contract for an Intents asset id, when the id actually contains one.
 * Solana omft ids store a 40-hex digest, not a mint, so those are skipped.
 */
export function dextoolsTarget(assetId: string): DextoolsToken | null {
  const raw = assetId.trim();
  const id = raw.replace(/^nep141:/i, '');

  const bridged = /^([a-z0-9]+)-(0x[0-9a-f]{40})\.(?:omft|omdep)\.near$/i.exec(id);
  if (bridged) {
    const chain = DEXTOOLS_CHAIN[bridged[1]!.toLowerCase()];
    return chain ? { chain, address: bridged[2]!.toLowerCase() } : null;
  }

  const factory = /^([0-9a-f]{40})\.factory\.bridge\.near$/i.exec(id);
  if (factory) return { chain: 'ether', address: `0x${factory[1]!.toLowerCase()}` };

  const stark = /^1cs_v1:starknet:erc20:(0x[0-9a-f]{1,80})$/i.exec(raw);
  if (stark) return { chain: 'starknet', address: stark[1]!.toLowerCase() };

  const sol = /^sol-([1-9A-HJ-NP-Za-km-z]{32,44})\.(?:omft|omdep)\.near$/.exec(id);
  if (sol && !/^[0-9a-f]{40}$/i.test(sol[1]!)) {
    return { chain: 'solana', address: sol[1]! };
  }

  // Unparsed omft ids (Solana digests, unknown chains) are not NEAR accounts.
  if (/\.(?:omft|omdep)\.near$/i.test(id)) return null;

  const near = nearFtAccount(raw);
  if (near && !/\.(?:omft|omdep)\.near$/i.test(near)) {
    return { chain: 'near', address: near };
  }

  return null;
}

/**
 * The NEAR account whose `ft_metadata` holds the token icon.
 * EVM omft ids are skipped: those logos come from the contract on the other chain.
 */
export function nearFtAccount(assetId: string): string | null {
  let id = assetId.trim();
  id = id.replace(/^1cs_v1:near:nep141:/i, '');
  id = id.replace(/^nep141:/i, '');
  if (id.length < 2 || id.length > 64) return null;
  if (/\.(?:omft|omdep)\.near$/i.test(id) && /0x[0-9a-f]{40}/i.test(id)) return null;
  const account = id.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(account)) return account;
  if (/^(([a-z\d]+[-_])*[a-z\d]+)(\.(([a-z\d]+[-_])*[a-z\d]+))+$/.test(account)) return account;
  return null;
}

/** A public https image URL from token metadata. Private and local hosts are refused. */
export function publicImageUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    !host.includes('.') ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    return null;
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return null;
  return url.toString();
}

/** An icon from NEAR `ft_metadata`: a data URL, or an image host the dashboard already allows. */
export function nearTokenIcon(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const icon = value.trim();
  if (icon.length < 16 || icon.length > 250_000) return null;
  if (icon.startsWith('https://')) {
    try {
      const url = new URL(icon);
      const allowed = new Set([
        'cdn.jsdelivr.net',
        'www.dextools.io',
        'assets.coingecko.com',
        'coin-images.coingecko.com',
        'icons.llamao.fi',
      ]);
      return url.protocol === 'https:' && allowed.has(url.hostname) ? url.toString() : null;
    } catch {
      return null;
    }
  }
  const match = /^data:image\/([a-z0-9.+-]+)(;base64)?,([\s\S]+)$/i.exec(icon);
  if (!match) return null;
  const declared = match[1]!.toLowerCase();
  if (!['png', 'jpeg', 'jpg', 'webp', 'gif', 'svg+xml'].includes(declared)) return null;
  if (!match[2]) return `data:image/${declared},${match[3]}`;
  const payload = match[3]!.replace(/\s/g, '');
  if (!/^[a-z0-9+/]+=*$/i.test(payload.slice(0, 64))) return null;
  const sniffed =
    payload.startsWith('iVBOR') ? 'png'
    : payload.startsWith('/9j/') ? 'jpeg'
    : payload.startsWith('UklGR') ? 'webp'
    : payload.startsWith('R0lGOD') ? 'gif'
    : payload.startsWith('PHN2Zy') || payload.startsWith('PD94bW') ? 'svg+xml'
    : null;
  const mime = sniffed ?? (declared === 'jpg' ? 'jpeg' : declared);
  return `data:image/${mime};base64,${payload}`;
}

/** Only Dextools' own logo files. Anything else is dropped before it reaches an img. */
export function dextoolsLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.dextools.io') return null;
  if (!url.pathname.startsWith('/resources/tokens/logos/')) return null;
  return url.toString();
}
