import type { DemoAssetOption, DemoChainVariant } from '@/lib/demo-assets';

export type TendrAiKind = 'recommended' | 'cheapest' | 'fastest';

export type TendrAiRoute = {
  kind: TendrAiKind;
  title: string;
  reason: string;
  eta: string;
  feeHint: string;
  assetId: string;
  symbol: string;
  optionLabel: string;
  iconSrc: string;
  chainName: string;
  chainLogoSrc: string;
  blockchain: string;
};

type Candidate = {
  option: DemoAssetOption;
  variant: DemoChainVariant;
  symbol: string;
  cost: number;
  speed: number;
  blend: number;
};

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USD1', 'USDE', 'USDF', 'USDG', 'XDAI']);

/** Lower = cheaper. Demo heuristics for the playground (not live quotes). */
function costScore(symbol: string, chain: string): number {
  const sym = symbol.toUpperCase().replace(/^\$/, '');
  const c = chain.toLowerCase();
  let score = 50;
  if (STABLES.has(sym)) score = 8;
  else if (sym === 'ETH' || sym === 'WETH') score = 28;
  else if (sym === 'SOL') score = 22;
  else if (sym === 'NEAR' || sym === 'WNEAR') score = 18;
  else if (sym === 'BNB') score = 30;
  else if (sym === 'BTC' || sym === 'WBTC' || sym === 'CBBTC') score = 70;
  else score = 40;

  if (c === 'base' || c === 'sol' || c === 'near') score -= 6;
  else if (c === 'arb' || c === 'op' || c === 'pol') score -= 3;
  else if (c === 'eth') score += 8;
  else if (c === 'btc') score += 12;
  else if (c === 'tron' || c === 'ton') score -= 2;
  return score;
}

/** Lower = faster settlement. */
function speedScore(symbol: string, chain: string): number {
  const sym = symbol.toUpperCase().replace(/^\$/, '');
  const c = chain.toLowerCase();
  let score = 40;
  if (c === 'sol' || c === 'base' || c === 'near') score = 10;
  else if (c === 'arb' || c === 'op' || c === 'pol' || c === 'ton') score = 16;
  else if (c === 'bsc' || c === 'avax' || c === 'tron') score = 22;
  else if (c === 'eth') score = 36;
  else if (c === 'btc' || c === 'ltc' || c === 'bch') score = 55;
  else score = 30;

  if (STABLES.has(sym)) score -= 2;
  if (sym === 'BTC') score += 8;
  return score;
}

function etaLabel(speed: number): string {
  if (speed <= 12) return '~8–15s';
  if (speed <= 20) return '~20–40s';
  if (speed <= 35) return '~1–2 min';
  return '~10–30 min';
}

function feeLabel(cost: number): string {
  if (cost <= 10) return '~$0.01–0.05';
  if (cost <= 20) return '~$0.05–0.20';
  if (cost <= 35) return '~$0.50–2';
  return 'higher network cost';
}

function buildCandidates(options: readonly DemoAssetOption[]): Candidate[] {
  const out: Candidate[] = [];
  for (const option of options) {
    if (option.disabled || !option.token) continue;
    for (const variant of option.chainVariants) {
      const symbol = (option.token.symbol || variant.token.symbol).replace(/^\$/, '');
      const cost = costScore(symbol, variant.blockchain);
      const speed = speedScore(symbol, variant.blockchain);
      out.push({
        option,
        variant,
        symbol,
        cost,
        speed,
        blend: cost * 0.55 + speed * 0.45,
      });
    }
  }
  return out;
}

function toRoute(
  kind: TendrAiKind,
  title: string,
  reason: string,
  c: Candidate,
): TendrAiRoute {
  return {
    kind,
    title,
    reason,
    eta: etaLabel(c.speed),
    feeHint: feeLabel(c.cost),
    assetId: c.variant.assetId,
    symbol: c.symbol,
    optionLabel: c.option.label,
    iconSrc: c.option.iconSrc,
    chainName: c.variant.name,
    chainLogoSrc: c.variant.logoSrc,
    blockchain: c.variant.blockchain,
  };
}

/**
 * Tendr AI demo router — picks cheapest / fastest / recommended from the live
 * asset catalog using deterministic heuristics (good for stage, no API).
 */
export function buildTendrAiRoutes(options: readonly DemoAssetOption[]): {
  recommended: TendrAiRoute | null;
  cheapest: TendrAiRoute | null;
  fastest: TendrAiRoute | null;
  byAssetId: Map<string, TendrAiKind[]>;
} {
  const candidates = buildCandidates(options);
  if (candidates.length === 0) {
    return { recommended: null, cheapest: null, fastest: null, byAssetId: new Map() };
  }

  const cheapest = [...candidates].sort((a, b) => a.cost - b.cost || a.speed - b.speed)[0]!;
  const fastest = [...candidates].sort((a, b) => a.speed - b.speed || a.cost - b.cost)[0]!;
  const recommended = [...candidates].sort((a, b) => a.blend - b.blend || a.cost - b.cost)[0]!;

  const routes = {
    recommended: toRoute(
      'recommended',
      'Recommended',
      `${recommended.symbol} on ${recommended.variant.name} — best balance of cost and speed`,
      recommended,
    ),
    cheapest: toRoute(
      'cheapest',
      'Cheapest',
      `${cheapest.symbol} on ${cheapest.variant.name} — lowest estimated network friction`,
      cheapest,
    ),
    fastest: toRoute(
      'fastest',
      'Fastest',
      `${fastest.symbol} on ${fastest.variant.name} — quickest expected settlement`,
      fastest,
    ),
  };

  const byAssetId = new Map<string, TendrAiKind[]>();
  const add = (route: TendrAiRoute) => {
    const list = byAssetId.get(route.assetId) ?? [];
    if (!list.includes(route.kind)) list.push(route.kind);
    byAssetId.set(route.assetId, list);
  };
  add(routes.recommended);
  add(routes.cheapest);
  add(routes.fastest);

  return { ...routes, byAssetId };
}

export function tendrAiBadgeLabel(kind: TendrAiKind): string {
  if (kind === 'recommended') return 'AI · Recommended';
  if (kind === 'cheapest') return 'AI · Cheapest';
  return 'AI · Fastest';
}
