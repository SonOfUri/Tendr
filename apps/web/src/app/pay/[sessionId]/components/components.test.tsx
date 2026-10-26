import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionView, Token } from '@/lib/checkout/api';
import { CheckoutHeader } from './CheckoutHeader';
import { CopyButton } from './CopyButton';
import { leftoversNotice } from './PayFlow';
import { WalletConnect } from './WalletConnect';
import { canPay } from './WalletPanel';

const VIEW = {
  id: 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0',
  livemode: true,
  merchant: { name: 'Bean Shop', logo_url: null },
  checkout_domains: ['https://shop.example'],
  amount: '84',
  amount_currency: 'USD',
  settlement_asset: 'nep141:usdc.test',
  status: 'PENDING_DEPOSIT',
  expires_at: '2026-10-26T12:20:00Z',
  fee_payer: 'merchant',
  gas_payer: 'merchant',
  success_url: 'https://shop.example/thanks',
  cancel_url: 'https://shop.example/cart',
  quote: null,
  payments: [],
  refunds: [],
  needs_email: false,
  topup: null,
} as SessionView;

const header = (canClose: boolean) =>
  renderToStaticMarkup(
    <CheckoutHeader
      view={VIEW}
      settlementSymbol={null}
      now={Date.parse('2026-10-26T12:00:00Z')}
      showTimer
      canClose={canClose}
      onClose={() => {}}
    />,
  );

describe('checkout components', () => {
  it('shows the × close control only when the bridge can tell the store page', () => {
    expect(header(true)).toContain('aria-label="Close checkout"');
    expect(header(false)).not.toContain('Close checkout');
  });

  it('CopyButton announces "Copied" from a live region outside the button', () => {
    const html = renderToStaticMarkup(<CopyButton value="0xabc" label="Copy the address" />);
    const button = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(button).not.toContain('aria-live');
    expect(html).toMatch(/aria-live="polite"/);
    expect(html.indexOf('aria-live')).toBeGreaterThan(html.indexOf('</button>'));
  });

  it('formats the leftovers threshold through formatUsd', () => {
    expect(leftoversNotice(1)).toBe("Leftovers under $1 aren't returned.");
    expect(leftoversNotice(2.5)).toBe("Leftovers under $2.50 aren't returned.");
    expect(leftoversNotice(Number.NaN)).toBe("Small leftovers aren't returned.");
    expect(leftoversNotice(1e21)).toBe("Small leftovers aren't returned.");
  });
});

describe('WalletConnect', () => {
  const NEAR_USDT: Token = {
    asset_id: 'nep141:usdt.tether-token.near',
    symbol: 'USDT',
    blockchain: 'near',
    decimals: 6,
    price_usd: '1',
    popular: true,
  };
  const quote = {
    id: 'quo_1',
    deposit_address: 'a'.repeat(64),
    amount_in: '84000000',
    origin_asset: NEAR_USDT.asset_id,
    deadline: '2026-10-26T12:10:00Z',
    refund_address: 'alice.near',
  };
  const NOW = Date.parse('2026-10-26T12:00:00Z');
  const base = {
    family: 'near' as const,
    address: 'alice.near',
    quote,
    now: NOW,
    livemode: true,
    paymentSent: false,
    busy: false,
  };

  it('pays only once the quote returns to the connected wallet, while it is live', () => {
    expect(canPay(base)).toBe(true);
    expect(canPay({ ...base, address: 'bob.near' })).toBe(false);
    expect(canPay({ ...base, quote: { ...quote, refund_address: null } })).toBe(false);
    expect(canPay({ ...base, now: Date.parse(quote.deadline) })).toBe(false);
    expect(canPay({ ...base, livemode: false })).toBe(false);
    expect(canPay({ ...base, paymentSent: true })).toBe(false);
    expect(canPay({ ...base, busy: true })).toBe(false);
    expect(
      canPay({
        ...base,
        family: 'evm',
        address: '0xAbCdEf0000000000000000000000000000000001',
        quote: { ...quote, refund_address: '0xabcdef0000000000000000000000000000000001' },
      }),
    ).toBe(true);
  });

  it('offers "Connect wallet" for a supported token', () => {
    const html = renderToStaticMarkup(<WalletConnect quote={quote} token={NEAR_USDT} />);
    expect(html).toContain('Connect wallet');
  });

  it('while blocked: no wallet step at all, only the notice and the "didn\'t go through" control', () => {
    const html = renderToStaticMarkup(
      <WalletConnect quote={quote} token={NEAR_USDT} blocked="sent" onDidntGoThrough={() => {}} />,
    );
    expect(html).toContain('Your payment is on its way');
    expect(html).not.toContain('Connect wallet');
    expect(html).not.toContain('Pay ');
    expect(html).toContain('My payment didn&#x27;t go through');
    // A token with no wallet route is blocked too (a popup-reported payment, another tab).
    const hot = renderToStaticMarkup(
      <WalletConnect
        quote={{ ...quote, origin_asset: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111' }}
        token={{ ...NEAR_USDT, blockchain: 'bsc' }}
        blocked="uncertain"
      />,
    );
    expect(hot).toContain('Check your wallet before paying again.');
    expect(hot).not.toContain('<button');
  });

  it('a token without a wallet route shows only the manual send', () => {
    const hot: Token = {
      ...NEAR_USDT,
      asset_id: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
      blockchain: 'bsc',
    };
    const html = renderToStaticMarkup(
      <WalletConnect quote={{ ...quote, origin_asset: hot.asset_id }} token={hot} />,
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('Send it yourself');
  });
});
