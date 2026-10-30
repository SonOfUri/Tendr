import type { Quote, SessionView, Token } from '@/lib/checkout/api';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import type { DemoCheckoutBootstrap } from '@/lib/demo';
import { buildDemoAssetOptions, DEMO_KNOWN_ASSETS } from '@/lib/demo-assets';

/** UI-only playground — no API, no fetch, never "fetch failed" on stage. */
export const DEMO_UI_ONLY = true;

type MockAsset = {
  symbol: string;
  /** 1Click blockchain id (`eth`, `btc`, `sol`, `near`…) — must match wallet adapters. */
  blockchain: string;
  /** Real-shaped asset id so `adapterFor` / Connect wallet still resolve. */
  assetId: string;
  decimals: number;
  priceUsd: number;
  popular?: boolean;
};

/**
 * Payable demo assets. IDs follow the 1Click `nep141:…` shapes that `payTargetFor` understands,
 * so Connect wallet keeps working in UI-only mode (Reown / NEAR / etc.).
 */
const MOCK_ASSETS: readonly MockAsset[] = [
  {
    symbol: 'BTC',
    blockchain: 'btc',
    assetId: 'nep141:btc.omft.near',
    decimals: 8,
    priceUsd: 60_000,
    popular: true,
  },
  {
    symbol: 'ETH',
    blockchain: 'eth',
    assetId: 'nep141:eth.omft.near',
    decimals: 18,
    priceUsd: 3_200,
    popular: true,
  },
  {
    symbol: 'SOL',
    blockchain: 'sol',
    assetId: 'nep141:sol.omft.near',
    decimals: 9,
    priceUsd: 145,
    popular: true,
  },
  {
    symbol: 'NEAR',
    blockchain: 'near',
    assetId: 'nep141:wrap.near',
    decimals: 24,
    priceUsd: 4.2,
    popular: true,
  },
  {
    symbol: 'USDT',
    blockchain: 'eth',
    assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    decimals: 6,
    priceUsd: 1,
    popular: true,
  },
  {
    symbol: 'USDC',
    blockchain: 'base',
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    decimals: 6,
    priceUsd: 1,
    popular: true,
  },
  {
    symbol: 'DAI',
    blockchain: 'eth',
    assetId: 'nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near',
    decimals: 18,
    priceUsd: 1,
  },
  {
    symbol: 'BNB',
    blockchain: 'bsc',
    assetId: 'nep141:bsc.omft.near',
    decimals: 18,
    priceUsd: 580,
  },
  {
    symbol: 'AVAX',
    blockchain: 'avax',
    assetId: 'nep141:avax.omft.near',
    decimals: 18,
    priceUsd: 28,
  },
  {
    symbol: 'ARB',
    blockchain: 'arb',
    assetId: 'nep141:arb.omft.near',
    decimals: 18,
    priceUsd: 0.85,
  },
  {
    symbol: 'OP',
    blockchain: 'op',
    assetId: 'nep141:op.omft.near',
    decimals: 18,
    priceUsd: 1.6,
  },
  {
    symbol: 'UNI',
    blockchain: 'eth',
    assetId: 'nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near',
    decimals: 18,
    priceUsd: 9.5,
  },
  {
    symbol: 'AAVE',
    blockchain: 'eth',
    assetId: 'nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near',
    decimals: 18,
    priceUsd: 180,
  },
  {
    symbol: 'SHIB',
    blockchain: 'eth',
    assetId: 'nep141:eth-0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce.omft.near',
    decimals: 18,
    priceUsd: 0.000018,
  },
  {
    symbol: 'PEPE',
    blockchain: 'eth',
    assetId: 'nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near',
    decimals: 18,
    priceUsd: 0.0000085,
  },
  // Manual-transfer only in the real wallet map (no omft / known mint) — still listed for Transfer.
  { symbol: 'XRP', blockchain: 'xrp', assetId: 'demo:xrp', decimals: 6, priceUsd: 0.55 },
  { symbol: 'DOGE', blockchain: 'doge', assetId: 'demo:doge', decimals: 8, priceUsd: 0.12 },
  { symbol: 'LTC', blockchain: 'ltc', assetId: 'demo:ltc', decimals: 8, priceUsd: 85 },
  { symbol: 'SUI', blockchain: 'sui', assetId: 'demo:sui', decimals: 9, priceUsd: 2.4 },
  { symbol: 'WIF', blockchain: 'sol', assetId: 'demo:wif', decimals: 6, priceUsd: 1.8 },
];

const KNOWN = new Set(DEMO_KNOWN_ASSETS.map((a) => a.symbol.toUpperCase()));

function mockDepositAddress(blockchain: string, salt: string): string {
  const b = blockchain.toLowerCase();
  const h = Array.from(salt)
    .reduce((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0)
    .toString(16)
    .replace('-', 'a')
    .padStart(8, '0');
  if (b === 'bitcoin' || b === 'btc') {
    return `bc1q${h}${'tendrdemo0000000000000000000000'.slice(0, 30)}`;
  }
  if (b === 'solana' || b === 'sol') {
    return `${h}TendrDemoSoL111111111111111111111111`;
  }
  if (b === 'near') {
    return `${h}.tendr-demo.near`;
  }
  if (b === 'xrp') {
    return `rTendr${h}DemoXXXXXXXXXXXXXXXX`;
  }
  // EVM-ish
  return `0x${h}${'a1b2c3d4e5f6789012345678abcdef01'.slice(0, 32)}`;
}

function toBaseUnits(human: number, decimals: number): string {
  if (!Number.isFinite(human) || human <= 0) return '0';
  const [whole, frac = ''] = human.toFixed(Math.min(decimals, 12)).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return raw || '0';
}

export function buildDemoUiTokens(): Token[] {
  return MOCK_ASSETS.filter((a) => KNOWN.has(a.symbol.toUpperCase())).map((a) => ({
    asset_id: a.assetId,
    symbol: a.symbol,
    blockchain: a.blockchain,
    decimals: a.decimals,
    price_usd: a.priceUsd,
    popular: Boolean(a.popular),
  }));
}

export function buildDemoUiQuote(token: Token, amountUsd: string): Quote {
  const usd = Number(amountUsd);
  const price = Number(token.price_usd) || 1;
  const human = usd / price;
  const amountIn = toBaseUnits(human, token.decimals);
  const now = Date.now();
  return {
    id: `demo_quote_${token.asset_id}_${now}`,
    origin_asset: token.asset_id,
    deposit_address: mockDepositAddress(token.blockchain, `${token.asset_id}:${amountUsd}`),
    amount_in: amountIn,
    amount_in_usd: usd.toFixed(2),
    deadline: new Date(now + 12 * 60 * 1000).toISOString(),
    expired: false,
    refund: 'origin_chain',
    refund_address: null,
    fee_lines: [],
    small_overpay_notice: false,
    small_overpay_usd: 0,
  };
}

export function buildDemoUiBootstrap(opts: {
  amount: string;
  currency: string;
  productName: string;
  merchantName: string;
  merchantLogoUrl: string;
  /** Live 1Click catalog when available; falls back to curated mock assets. */
  tokens?: Token[];
}): DemoCheckoutBootstrap & { sessionId: string; clientSecret: string } {
  const tokens = opts.tokens?.length ? opts.tokens : buildDemoUiTokens();
  const token = buildDemoAssetOptions(tokens).find((o) => o.token)?.token ?? tokens[0];
  const tokenId = token?.asset_id ?? '';
  const sessionId = `demo_sess_${Date.now().toString(36)}`;
  const session: SessionView = {
    id: sessionId,
    livemode: false,
    merchant: { name: opts.merchantName },
    theme: tendrShopperTheme(opts.merchantName, opts.merchantLogoUrl),
    checkout_domains: ['*'],
    amount: opts.amount,
    amount_currency: opts.currency,
    settlement_asset: 'USDC',
    status: 'open',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    fee_payer: 'merchant',
    gas_payer: 'merchant',
    success_url: null,
    cancel_url: null,
    quote: null,
    payments: [],
    refunds: [],
    needs_email: false,
    deposit_submitted_at: null,
    topup: null,
  };
  const quote = token ? buildDemoUiQuote(token, opts.amount) : null;
  return {
    sessionId,
    clientSecret: 'demo_ui_only_secret',
    session,
    tokens,
    tokenId,
    quote,
  };
}
