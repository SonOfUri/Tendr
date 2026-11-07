// @vitest-environment jsdom
import type { PublicPaymentLinkView } from '@tendr/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import { initialPayState, LinkPayBody } from './LinkPay';

afterEach(() => cleanup());

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

describe('link page demo card', () => {
  it('shows amount and payee on the demo checkout card (no sticky pay bar)', () => {
    const root = draw(VIEW);
    expect(root.querySelector('[data-pay-bar]')).toBeNull();
    expect(root.querySelector('.demo-checkout-card')).not.toBeNull();
    expect(root.querySelector('.demo-pay-page')).not.toBeNull();
    expect(root.querySelector('.demo-pay-theme-toggle')).not.toBeNull();
    expect(root.querySelector('.demo-checkout-footnote')?.textContent).toContain('Powered by');
    expect(root.textContent).toContain('$15');
    expect(root.textContent).toContain('Paying Lagos Leather Co.');
    expect(root.textContent).toContain('· trading as Kola Kicks');
  });

  it('keeps the card when the link takes no payments, without a pay button', () => {
    const root = draw({ ...VIEW, availability: 'expired' });
    expect(root.querySelector('.demo-checkout-card')).not.toBeNull();
    expect(root.textContent).toContain('This link has expired');
    expect(root.textContent).not.toContain('Pay with crypto');
    expect(root.querySelector('.demo-checkout-footnote')?.textContent).toContain('Powered by');
  });
});
