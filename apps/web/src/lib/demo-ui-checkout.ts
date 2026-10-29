import type { Quote, SessionView, Token } from '@/lib/checkout/api';
import type { DemoCheckoutBootstrap } from '@/lib/demo';
import { DEMO_KNOWN_ASSETS } from '@/lib/demo-assets';

/** UI-only playground — no API, no fetch, never "fetch failed" on stage. */
export const DEMO_UI_ONLY = true;

type MockAsset = {
  symbol: string;
  blockchain: string;
  decimals: number;
  priceUsd: number;
  popular?: boolean;
};

/** Payable assets with stable demo prices for local quotes. */
const MOCK_ASSETS: readonly MockAsset[] = [
  { symbol: 'BTC', blockchain: 'bitcoin', decimals: 8, priceUsd: 60_000, popular: true },
  { symbol: 'ETH', blockchain: 'ethereum', decimals: 18, priceUsd: 3_200, popular: true },
  { symbol: 'SOL', blockchain: 'solana', decimals: 9, priceUsd: 145, popular: true },
  { symbol: 'NEAR', blockchain: 'near', decimals: 24, priceUsd: 4.2, popular: true },
  { symbol: 'USDT', blockchain: 'ethereum', decimals: 6, priceUsd: 1, popular: true },
  { symbol: 'USDC', blockchain: 'base', decimals: 6, priceUsd: 1, popular: true },
  { symbol: 'DAI', blockchain: 'ethereum', decimals: 18, priceUsd: 1 },
  { symbol: 'BNB', blockchain: 'bsc', decimals: 18, priceUsd: 580 },
  { symbol: 'XRP', blockchain: 'xrp', decimals: 6, priceUsd: 0.55 },
  { symbol: 'DOGE', blockchain: 'dogecoin', decimals: 8, priceUsd: 0.12 },
  { symbol: 'LTC', blockchain: 'litecoin', decimals: 8, priceUsd: 85 },
  { symbol: 'AVAX', blockchain: 'avalanche', decimals: 18, priceUsd: 28 },
  { symbol: 'ARB', blockchain: 'arbitrum', decimals: 18, priceUsd: 0.85 },
  { symbol: 'OP', blockchain: 'optimism', decimals: 18, priceUsd: 1.6 },
  { symbol: 'SUI', blockchain: 'sui', decimals: 9, priceUsd: 2.4 },
  { symbol: 'SHIB', blockchain: 'ethereum', decimals: 18, priceUsd: 0.000018 },
  { symbol: 'PEPE', blockchain: 'ethereum', decimals: 18, priceUsd: 0.0000085 },
  { symbol: 'WIF', blockchain: 'solana', decimals: 6, priceUsd: 1.8 },
  { symbol: 'UNI', blockchain: 'ethereum', decimals: 18, priceUsd: 9.5 },
  { symbol: 'AAVE', blockchain: 'ethereum', decimals: 18, priceUsd: 180 },
];

const KNOWN = new Set(DEMO_KNOWN_ASSETS.map((a) => a.symbol.toUpperCase()));

function assetId(symbol: string, chain: string) {
  return `demo_${symbol.toLowerCase()}_${chain.toLowerCase()}`;
}

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
    asset_id: assetId(a.symbol, a.blockchain),
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
}): DemoCheckoutBootstrap & { sessionId: string; clientSecret: string } {
  const tokens = buildDemoUiTokens();
  const tokenId = tokens[0]?.asset_id ?? '';
  const token = tokens[0]!;
  const sessionId = `demo_sess_${Date.now().toString(36)}`;
  const session: SessionView = {
    id: sessionId,
    livemode: false,
    merchant: {
      name: opts.merchantName,
      logo_url: opts.merchantLogoUrl,
    },
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
