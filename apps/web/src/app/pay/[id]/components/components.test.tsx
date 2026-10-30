// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { TENDR_DEFAULT_THEME, type ShopperTheme } from '@tendr/contracts';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkFee as NetworkFeeView, SessionView, Token } from '@/lib/checkout/api';
import { CheckoutHeader } from './CheckoutHeader';
import { CopyButton } from './CopyButton';
import { PayFlow, QuotePending, leftoversNotice, refundToCarry } from './PayFlow';
import { CONFIRM_NOT_SENT_COPY } from './WalletConnect';
import { WalletConnect } from './WalletConnect';
import { StatusScreen } from './StatusScreens';
import { canPay } from './WalletPanel';
import { NetworkFee, showFeeChoice } from './NetworkFee';
import { SendDetails } from './SendDetails';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import { Celebration } from '@/components/theme/Celebration';
import { CheckoutCanvas } from './CheckoutCanvas';

const VIEW = {
  id: 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0',
  livemode: true,
  merchant: { name: 'Bean Shop' },
  theme: tendrShopperTheme('Bean Shop'),
  line_items: [],
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

  it('the header back link reads "Back to <title>" for a session from a payment link', () => {
    const render = (view: SessionView) =>
      renderToStaticMarkup(
        <CheckoutHeader
          view={view}
          settlementSymbol={null}
          now={Date.parse('2026-10-26T12:00:00Z')}
          showTimer
          canClose={false}
          onClose={() => {}}
        />,
      );
    const linked = render({
      ...VIEW,
      cancel_url: 'https://usetendr.tech/pay/acme/tip-jar',
      payment_link: { title: 'Tip <jar>', url: 'https://usetendr.tech/pay/acme/tip-jar' },
    } as SessionView);
    expect(linked).toContain('Back to Tip &lt;jar&gt;');
    expect(linked).toContain('href="https://usetendr.tech/pay/acme/tip-jar"');
    expect(linked).not.toContain('Back to store');
    const plain = render({ ...VIEW, payment_link: null } as SessionView);
    expect(plain).toContain('Back to store');
    expect(plain).toContain('href="https://shop.example/cart"');
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

describe('StatusScreen: sessions from a payment link', () => {
  const screen = (kind: 'complete' | 'expired', view: SessionView) =>
    renderToStaticMarkup(
      <StatusScreen
        view={view}
        screen={{
          kind,
          terminal: true,
          pollMs: 5000,
          bridgeStatus: null,
          action: null,
          notice: null,
          payment: null,
          refundNeedingAddress: null,
        }}
        tokenOf={() => null}
        client={{} as never}
        now={Date.parse('2026-10-26T12:00:00Z')}
        onRefresh={() => {}}
      />,
    );
  const linked = {
    ...VIEW,
    success_url: 'https://usetendr.tech/pay/acme/tip-jar',
    cancel_url: 'https://usetendr.tech/pay/acme/tip-jar',
    payment_link: { title: 'Tip <jar>', url: 'https://usetendr.tech/pay/acme/tip-jar' },
  } as SessionView;

  it('reads "Back to <title>" and goes to the link instead of "Return to store"', () => {
    for (const kind of ['complete', 'expired'] as const) {
      const html = screen(kind, linked);
      expect(html).toContain('Back to Tip &lt;jar&gt;');
      expect(html).toContain('href="https://usetendr.tech/pay/acme/tip-jar"');
      expect(html).not.toContain('Return to store');
    }
  });

  it('keeps "Return to store" for ordinary sessions', () => {
    const html = screen('complete', { ...VIEW, payment_link: null } as SessionView);
    expect(html).toContain('Return to store');
    expect(html).toContain('href="https://shop.example/thanks"');
  });

  it('the expired screen sends the payer back to the link page to start again', () => {
    const html = screen('expired', linked);
    expect(html).toContain('Go back to Tip &lt;jar&gt; to start again.');
    expect(html).not.toContain('Return to the store');
    const plain = screen('expired', { ...VIEW, payment_link: null } as SessionView);
    expect(plain).toContain('Return to the store to start again.');
    expect(plain).toContain('href="https://shop.example/cart"');
  });
});

describe('NetworkFee (Global Constraints copy)', () => {
  const USDC = { symbol: 'USDC', decimals: 6 };
  const fee = (over: Partial<NetworkFeeView>): NetworkFeeView => ({
    paid_by: 'shopper',
    fee_mode: 'token',
    amount: '96000',
    asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    usd: '0.096',
    method: 'eip3009',
    reason: 'not_sponsored',
    ...over,
  });
  const render = (props: Partial<Parameters<typeof NetworkFee>[0]>) =>
    renderToStaticMarkup(
      <NetworkFee
        networkFee={null}
        merchantName="Bean Shop"
        token={USDC}
        coin="ETH"
        choice={null}
        {...props}
      />,
    );

  it('merchant sponsors: "Network fee: paid by {merchant}", and no choice', () => {
    const html = render({
      networkFee: fee({ paid_by: 'merchant', fee_mode: null, amount: null, reason: null }),
    });
    expect(html).toContain('Network fee: paid by Bean Shop');
    expect(html).not.toContain('Pay the fee in');
  });

  it('shopper pays in the token without a choice: "Network fee: +0.096 USDC"', () => {
    expect(render({ networkFee: fee({}) })).toContain('Network fee: +0.096 USDC');
  });

  it('the choice: "Pay the fee in USDC" (+0.096 USDC) / "Pay the fee in ETH", the selection checked', () => {
    const html = render({
      networkFee: fee({}),
      choice: { mode: 'token', tokenFeeAmount: '96000', onChoose: () => {} },
    });
    expect(html).toContain('Pay the fee in USDC');
    expect(html).toContain('+0.096 USDC');
    expect(html).toContain('Pay the fee in ETH');
    const input = (h: string, v: string) =>
      h.match(new RegExp(`<input[^>]*value="${v}"[^>]*>`))![0];
    expect(input(html, 'token')).toContain('checked');
    expect(input(html, 'native')).not.toContain('checked');
    const native = render({
      networkFee: fee({ fee_mode: 'native', amount: null }),
      choice: { mode: 'native', tokenFeeAmount: '96000', onChoose: () => {} },
    });
    expect(input(native, 'native')).toContain('checked');
    expect(native).toContain('+0.096 USDC');
  });

  it('no gasless method: "You\'ll need {coin} for the network fee"', () => {
    expect(
      render({ networkFee: fee({ fee_mode: 'native', amount: null, method: 'native' }) }),
    ).toContain('You&#x27;ll need ETH for the network fee');
    expect(render({ networkFee: null })).toContain('You&#x27;ll need ETH for the network fee');
  });

  it('the shopper only ever sees "not sponsored"-style reasons, never budget wording', () => {
    // Even a merchant-side reason leaking through the API is never rendered (m2).
    for (const reason of ['budget_exhausted', 'per_payment_cap', 'loss_cap', 'not_sponsored']) {
      for (const choice of [
        null,
        { mode: 'token' as const, tokenFeeAmount: '96000', onChoose() {} },
      ]) {
        const html = render({ networkFee: fee({ reason }), choice });
        expect(html).not.toMatch(/budget|cap|loss|sponsor/i);
      }
      expect(
        render({ networkFee: fee({ reason, paid_by: 'merchant', fee_mode: null }) }),
      ).not.toMatch(/budget|cap|loss/i);
    }
  });

  it('the choice appears only when the shopper pays and both ways exist', () => {
    const shopper = {
      method: 'eip3009' as const,
      paid_by: 'shopper' as const,
      reason: 'not_sponsored',
      fee_modes: ['token', 'native'] as ('token' | 'native')[],
      token_fee: { amount: '96000', symbol: 'USDC', decimals: 6, usd: '0.096' },
    };
    expect(showFeeChoice(shopper, fee({}))).toBe(true);
    // The merchant sponsors: no choice to make.
    expect(
      showFeeChoice(
        { ...shopper, paid_by: 'merchant', fee_modes: [] },
        fee({ paid_by: 'merchant' }),
      ),
    ).toBe(false);
    // The quote came back sponsored after all.
    expect(showFeeChoice(shopper, fee({ paid_by: 'merchant' }))).toBe(false);
    expect(showFeeChoice({ ...shopper, fee_modes: ['token'] }, fee({}))).toBe(false);
    expect(showFeeChoice(null, fee({}))).toBe(false);
  });

  it('the copy-address path says the shopper pays the network fee', () => {
    const html = renderToStaticMarkup(
      <SendDetails address="0xabc" amount="25" symbol="USDC" network="Base" />,
    );
    expect(html).toContain('You pay the network fee from your wallet');
  });

  it('a gasless quote is payable in test mode too (nothing is sent on chain there)', () => {
    const q = {
      refund_address: '0x1111111111111111111111111111111111111111',
      deadline: '2026-10-26T12:10:00Z',
    };
    const base = {
      family: 'evm' as const,
      address: q.refund_address,
      quote: q,
      now: Date.parse('2026-10-26T12:00:00Z'),
      livemode: false,
      paymentSent: false,
      busy: false,
    };
    expect(canPay(base)).toBe(false);
    expect(canPay({ ...base, gasless: true })).toBe(true);
  });
});

// ─── Themed checkout (checkout themes) ───────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** `window.matchMedia` answering `matches` for the queries in `on`. */
function stubMedia(on: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** An IntersectionObserver reporting each observed element as `visible` (0–1) on screen. */
function stubObserver(visible: number) {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        const height = 1000;
        this.cb(
          [
            {
              target: el,
              isIntersecting: visible > 0,
              intersectionRatio: visible,
              boundingClientRect: { height } as DOMRectReadOnly,
              intersectionRect: { height: height * visible } as DOMRectReadOnly,
              rootBounds: { height: 812 } as DOMRectReadOnly,
            } as unknown as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    },
  );
}

function shopperTheme(patch: Partial<ShopperTheme['document']['settings']> = {}): ShopperTheme {
  const document = TENDR_DEFAULT_THEME('Kola Kicks');
  return {
    id: 'thm_1',
    version: 1,
    document: { ...document, settings: { ...document.settings, ...patch } },
    rendered: {},
    assets: {},
    css: null,
    payee: 'Lagos Leather Co.',
    trading_as: 'Kola Kicks',
  };
}

const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'");

describe('themed checkout', () => {
  it('payee line uses account name and trading as', () => {
    const view = { ...VIEW, merchant: { name: 'Lagos Leather Co.' } } as SessionView;
    const draw = (tradingAs: string | null) =>
      renderToStaticMarkup(
        <CheckoutHeader
          view={view}
          tradingAs={tradingAs}
          settlementSymbol={null}
          now={Date.parse('2026-10-26T12:00:00Z')}
          showTimer
          canClose={false}
          onClose={() => {}}
        />,
      );
    const html = draw('Kola Kicks');
    expect(textOf(html)).toContain("You're paying Lagos Leather Co. · trading as Kola Kicks");
    // The theme's display name never stands in for the payee.
    expect(textOf(html)).not.toContain('paying Kola Kicks');
    // Logo and store name live in the theme's header block now, not the sealed block.
    expect(html).not.toContain('pay-store-name');
    const same = textOf(draw(null));
    expect(same).toContain("You're paying Lagos Leather Co.");
    expect(same).not.toContain('trading as');
  });

  it('pay bar hidden on status screens', () => {
    stubMedia(['(max-width: 640px)']);
    stubObserver(0);
    const draw = (screen: 'pay' | 'expired' | 'complete' | 'held') =>
      render(
        <CheckoutCanvas
          view={VIEW}
          theme={shopperTheme()}
          screen={screen}
          sealed={<p>sealed</p>}
          amountText="$84.00"
        />,
      );
    const pay = draw('pay');
    const bar = pay.container.querySelector('[data-pay-bar]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('$84.00');
    expect(bar!.textContent).toContain('Bean Shop');
    cleanup();
    for (const screen of ['expired', 'complete', 'held'] as const) {
      const r = draw(screen);
      expect(r.container.querySelector('[data-pay-bar]')).toBeNull();
      cleanup();
    }
  });

  it('pay bar shows only on a phone while the payment block is mostly off screen', () => {
    const draw = () =>
      render(
        <CheckoutCanvas
          view={VIEW}
          theme={shopperTheme()}
          screen="pay"
          sealed={<button type="button">Choose</button>}
          amountText="$84.00"
        />,
      );
    stubMedia([]);
    stubObserver(0);
    expect(draw().container.querySelector('[data-pay-bar]')).toBeNull();
    cleanup();
    stubMedia(['(max-width: 640px)']);
    stubObserver(0.5);
    expect(draw().container.querySelector('[data-pay-bar]')).toBeNull();
    cleanup();
    stubObserver(0.1);
    const r = draw();
    const sealed = r.container.querySelector('.tdr-payment') as HTMLElement;
    const scroll = vi.fn();
    sealed.scrollIntoView = scroll;
    act(() => {
      (r.container.querySelector('[data-pay-bar] button') as HTMLButtonElement).click();
    });
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe('Choose');
    expect(r.container.querySelector('[data-pay-bar]')).toBeNull();
  });

  it('success canvas renders thank you and back to store', () => {
    const draw = (theme: ShopperTheme) =>
      render(
        <CheckoutCanvas
          view={VIEW}
          theme={theme}
          screen="complete"
          sealed={<h2>Payment complete</h2>}
          amountText="$84.00"
        />,
      ).container;
    const plain = draw(shopperTheme());
    expect(plain.textContent).toContain('Payment received — thank you.');
    const back = plain.querySelector('a[href="https://shop.example/thanks"]');
    expect(back?.textContent).toBe('Return to store');
    // Thank-you and back-to-store are merchant blocks; the payment status stays sealed.
    expect(back!.closest('.tdr-wrap')).not.toBeNull();
    expect(plain.querySelector('.tdr-payment')?.textContent).toBe('Payment complete');
    cleanup();
    const custom = draw(shopperTheme({ success_message: 'Merci, see you soon!' }));
    expect(custom.textContent).toContain('Merci, see you soon!');
    expect(custom.textContent).not.toContain('Payment received — thank you.');
  });

  it('the complete screen keeps its own way back only when asked to', () => {
    const draw = (showBackLink: boolean) =>
      renderToStaticMarkup(
        <StatusScreen
          view={VIEW}
          screen={{
            kind: 'complete',
            terminal: true,
            pollMs: 5000,
            bridgeStatus: null,
            action: null,
            notice: null,
            payment: null,
            refundNeedingAddress: null,
          }}
          tokenOf={() => null}
          client={{} as never}
          now={Date.parse('2026-10-26T12:00:00Z')}
          onRefresh={() => {}}
          showBackLink={showBackLink}
        />,
      );
    expect(draw(false)).not.toContain('Return to store');
    expect(draw(true)).toContain('Return to store');
  });

  it('celebration skipped with reduced motion', () => {
    stubMedia(['(prefers-reduced-motion: reduce)']);
    const reduced = render(<Celebration kind="confetti" />);
    expect(reduced.container.querySelector('.tdr-celebration')).toBeNull();
    cleanup();
    stubMedia([]);
    const shown = render(<Celebration kind="confetti" />);
    expect(shown.container.querySelector('.tdr-celebration')).not.toBeNull();
    cleanup();
    const none = render(<Celebration kind="none" />);
    expect(none.container.querySelector('.tdr-celebration')).toBeNull();
  });
});
