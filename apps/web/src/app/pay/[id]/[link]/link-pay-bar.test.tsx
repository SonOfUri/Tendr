// @vitest-environment jsdom
import type { PublicPaymentLinkView } from '@tendr/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import { initialPayState, LinkPayBody } from './LinkPay';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const VIEW: PublicPaymentLinkView = {
  merchant: { name: 'Lagos Leather Co.' },
  theme: {
    ...tendrShopperTheme('Kola Kicks'),
    payee: 'Lagos Leather Co.',
    trading_as: 'Kola Kicks',
  },
  title: 'Gift card',
  description: null,
  amount_type: 'fixed',
  amount: '15.00',
  currency: 'USD',
  minor_units: 2,
  min_amount: null,
  usd_rate: null,
  note: 'off',
  fee_payer: 'merchant',
  availability: 'available',
  livemode: true,
};

/** A phone, with the payment block reported 0% on screen. */
function phoneWithBlockOffScreen() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 640px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        this.cb(
          [
            {
              target: el,
              isIntersecting: false,
              intersectionRatio: 0,
              boundingClientRect: { height: 600 } as DOMRectReadOnly,
              intersectionRect: { height: 0 } as DOMRectReadOnly,
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

const draw = (view: PublicPaymentLinkView) =>
  render(
    <LinkPayBody
      view={view}
      state={initialPayState(view)}
      onAmount={() => {}}
      onNote={() => {}}
      onSubmit={() => {}}
    />,
  ).container;

describe('link page pay bar', () => {
  it('shows the amount and the account name while the payment block is off screen', () => {
    phoneWithBlockOffScreen();
    const bar = draw(VIEW).querySelector('[data-pay-bar]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('$15');
    expect(bar!.textContent).toContain("You're paying Lagos Leather Co.");
    expect(bar!.textContent).not.toContain('Kola Kicks');
  });

  it('is not shown when the link takes no payments', () => {
    phoneWithBlockOffScreen();
    expect(draw({ ...VIEW, availability: 'expired' }).querySelector('[data-pay-bar]')).toBeNull();
  });
});
