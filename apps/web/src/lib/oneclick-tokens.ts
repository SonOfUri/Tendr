import type { Token } from '@/lib/checkout/api';

const ONECLICK_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
const COINGECKO_MARKETS =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1&sparkline=false';

/** Raw row from https://1click.chaindefuser.com/v0/tokens */
export type OneClickToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number | null;
  priceUpdatedAt?: string;
  contractAddress?: string;
  coingeckoId?: string;
};

let cache: { at: number; tokens: OneClickToken[]; logos: Map<string, string> } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function fetchOneClickTokens(force = false): Promise<OneClickToken[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.tokens;
  const res = await fetch(ONECLICK_TOKENS_URL, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`1Click tokens failed (${res.status})`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('1Click tokens: expected a JSON array');
  const tokens = data.filter(isOneClickToken);
  const logos = await fetchCoingeckoLogoMap(tokens);
  cache = { at: Date.now(), tokens, logos };
  return tokens;
}

/** CoinGecko image URLs keyed by coingecko id (slug). */
export function coingeckoLogoMap(): Map<string, string> {
  return cache?.logos ?? new Map();
}

async function fetchCoingeckoLogoMap(tokens: readonly OneClickToken[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      tokens
        .map((t) => t.coingeckoId?.trim())
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !id.startsWith('custom:')),
    ),
  ];
  const logos = new Map<string, string>();
  if (ids.length === 0) return logos;

  // CoinGecko allows ~250 ids per markets call; chunk just in case.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    try {
      const url = `${COINGECKO_MARKETS}&ids=${encodeURIComponent(chunk.join(','))}`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ id?: string; image?: string }>;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row.id && row.image) logos.set(row.id, rewriteCoingeckoImageUrl(row.image));
      }
    } catch {
      // Logos are best-effort — catalog still works without them.
    }
  }
  return logos;
}

/**
 * CoinGecko's markets API returns `coin-images.coingecko.com` URLs that often fail in
 * browsers; `assets.coingecko.com` serves the same paths and loads cleanly.
 */
function rewriteCoingeckoImageUrl(url: string): string {
  return url
    .replace('://coin-images.coingecko.com/', '://assets.coingecko.com/')
    .replace('/large/', '/small/');
}

function isOneClickToken(row: unknown): row is OneClickToken {
  if (!row || typeof row !== 'object') return false;
  const t = row as Record<string, unknown>;
  return (
    typeof t.assetId === 'string' &&
    typeof t.symbol === 'string' &&
    typeof t.blockchain === 'string' &&
    typeof t.decimals === 'number'
  );
}

/** Drop deprecated / empty-symbol noise from the live catalog. */
export function filterLiveOneClickTokens(rows: readonly OneClickToken[]): OneClickToken[] {
  return rows.filter((t) => {
    const sym = t.symbol.trim();
    if (!sym) return false;
    if (/deprecated/i.test(sym)) return false;
    return true;
  });
}

/** Map a 1Click row into the checkout `Token` shape used by the demo. */
export function oneClickToCheckoutToken(row: OneClickToken, logos?: Map<string, string>): Token {
  const cg = row.coingeckoId?.trim() || null;
  const logo = (cg && logos?.get(cg)) || null;
  return {
    asset_id: row.assetId,
    symbol: row.symbol,
    blockchain: row.blockchain,
    decimals: row.decimals,
    price_usd: row.price ?? null,
    popular: isPopularSymbol(row.symbol),
    coingecko_id: cg,
    logo_url: logo,
  };
}

const POPULAR = new Set([
  'BTC',
  'ETH',
  'SOL',
  'NEAR',
  'WNEAR',
  'USDT',
  'USDC',
  'DAI',
  'BNB',
  'AVAX',
  'ARB',
  'OP',
  'XRP',
  'DOGE',
  'SUI',
  'TON',
  'TRX',
]);

function isPopularSymbol(symbol: string): boolean {
  return POPULAR.has(symbol.trim().toUpperCase().replace(/^\$/, ''));
}
