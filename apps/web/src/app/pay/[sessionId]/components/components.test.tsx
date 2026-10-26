import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionView } from '@/lib/checkout/api';
import { CheckoutHeader } from './CheckoutHeader';
import { CopyButton } from './CopyButton';
import { leftoversNotice } from './PayFlow';

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
