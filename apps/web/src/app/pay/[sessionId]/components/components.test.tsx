import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionView, Token } from '@/lib/checkout/api';
import { CheckoutHeader } from './CheckoutHeader';
import { CopyButton } from './CopyButton';
import { PayFlow, QuotePending, leftoversNotice, refundToCarry } from './PayFlow';
import { CONFIRM_NOT_SENT_COPY } from './WalletConnect';
import { WalletConnect } from './WalletConnect';
import { StatusScreen } from './StatusScreens';
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

describe('PayFlow while a payment may be on its way (C33)', () => {
  const token: Token = {
    asset_id: 'nep141:usdt.tether-token.near',
    symbol: 'USDT',
    blockchain: 'near',
    decimals: 6,
    price_usd: '1',
    popular: true,
  };
  const DEPOSIT = 'b'.repeat(64);
  const view = {
    ...VIEW,
    quote: {
      id: 'quo_01JAAAAAAAAAAAAAAAAAAAAAAA',
      origin_asset: token.asset_id,
      deposit_address: DEPOSIT,
      amount_in: '84000000',
      amount_in_usd: '84',
      deadline: '2026-10-26T12:10:00Z',
      expired: false,
      refund: 'store',
      refund_address: null,
      fee_lines: [],
      small_overpay_notice: false,
      small_overpay_usd: 1,
    },
  } as SessionView;
  const render = (now: string) =>
    renderToStaticMarkup(
      <PayFlow
        view={view}
        client={{} as never}
        tokens={[token]}
        now={Date.parse(now)}
        onQuote={() => {}}
        onRefresh={() => {}}
        blocked="sent"
        onDidntGoThrough={() => {}}
      />,
    );

  it('before the deadline the manual send details stay', () => {
    const html = render('2026-10-26T12:00:00Z');
    expect(html).toContain(DEPOSIT);
    expect(html).toContain('Your payment is on its way');
  });

  it('past the deadline only the notice and the confirm control remain', () => {
    const html = render('2026-10-26T12:11:00Z');
    expect(html).not.toContain(DEPOSIT);
    expect(html).not.toContain('send it yourself');
    expect(html).toContain('Your payment is on its way');
    expect(html).toContain('My payment didn&#x27;t go through');
  });

  it('the confirm copy covers a failed and a never-sent payment', () => {
    expect(CONFIRM_NOT_SENT_COPY).toContain('shows this payment failed or was never sent');
  });
});

describe('PayFlow with no current quote (C35)', () => {
  it('a blocked tab with no quote shows the notice and the "didn\'t go through" control', () => {
    const html = renderToStaticMarkup(
      <QuotePending blocked="sent" loading={false} onDidntGoThrough={() => {}} />,
    );
    expect(html).toContain('Your payment is on its way');
    expect(html).toContain('My payment didn&#x27;t go through');
    expect(html).not.toContain('Getting your price');
  });

  it('not blocked: the loading line while the price is fetched, else nothing', () => {
    expect(renderToStaticMarkup(<QuotePending blocked={null} loading />)).toContain(
      'Getting your price',
    );
    expect(renderToStaticMarkup(<QuotePending blocked={null} loading={false} />)).toBe('');
  });

  it('T12: a refused carried return address says why and offers to continue without it', () => {
    const html = renderToStaticMarkup(
      <QuotePending
        blocked={null}
        loading={false}
        refundError="This address can't be used for this payment."
        onRetryWithoutRefund={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('This address can&#x27;t be used for this payment.');
    expect(html).toContain('Continue without a refund address');
    // Never silent, but the loading line wins while the retry runs.
    expect(
      renderToStaticMarkup(
        <QuotePending blocked={null} loading refundError="x" onRetryWithoutRefund={() => {}} />,
      ),
    ).toContain('Getting your price');
  });

  it('a fresh quote carries the last return address the shopper had on that network', () => {
    const last = { address: '0xrefund', blockchain: 'eth' };
    expect(refundToCarry(last, 'eth')).toBe('0xrefund');
    // A token on another network can't use it.
    expect(refundToCarry(last, 'near')).toBeNull();
    expect(refundToCarry(null, 'eth')).toBeNull();
    expect(refundToCarry({ address: null, blockchain: 'eth' }, 'eth')).toBeNull();
  });
});

describe('StatusScreen: the extra paid (C42)', () => {
  const settled = (refundState: string | null) => {
    const payment = {
      id: 'pay_1',
      state: 'settled',
      amount_received: '1100',
      overpaid_amount: '100',
      refunded_amount: '100',
      kept_small_overpayment: false,
      kept_extra: false,
      origin_tx_hash: null,
      created_at: '2026-10-26T12:00:00Z',
    };
    const view = {
      ...VIEW,
      status: 'SETTLED',
      payments: [payment],
      refunds: refundState
        ? [
            {
              id: 'ref_1',
              payment_id: 'pay_1',
              asset: 'nep141:eth.test',
              amount: '90',
              needs_address: false,
              state: refundState,
            },
          ]
        : [],
    } as SessionView;
    return renderToStaticMarkup(
      <StatusScreen
        view={view}
        screen={{
          kind: 'complete',
          terminal: true,
          pollMs: 5000,
          bridgeStatus: null,
          action: null,
          notice: null,
          payment,
          refundNeedingAddress: null,
        }}
        tokenOf={() => null}
        client={{} as never}
        now={Date.parse('2026-10-26T12:00:00Z')}
        onRefresh={() => {}}
      />,
    );
  };

  it('a blocked return in review asks the shopper to contact the store, never "being sent back"', () => {
    const html = settled('review');
    expect(html).toContain('Contact the store about the extra you paid.');
    expect(html).not.toContain('being sent back');
  });

  it('a return in progress is being sent back', () => {
    expect(settled('processing')).toContain('being sent back to you');
  });
});
