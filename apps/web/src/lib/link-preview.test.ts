import type { PublicPaymentLinkView } from '@tendr/contracts';
import { describe, expect, it } from 'vitest';
import { linkCardPrice } from './link-preview';

const view = (over: Partial<PublicPaymentLinkView>) =>
  ({
    amount_type: 'fixed',
    amount: '25000.00',
    currency: 'NGN',
    minor_units: 2,
    availability: 'available',
    ...over,
  }) as PublicPaymentLinkView;

describe('linkCardPrice', () => {
  it('uses the ISO code when the symbol has no glyph in the card font', () => {
    expect(linkCardPrice(view({}))).toBe('NGN 25,000.00');
    expect(linkCardPrice(view({ currency: 'USD', amount: '15.20' }))).toBe('$15.20');
    expect(linkCardPrice(view({ amount_type: 'open', amount: null }))).toBe('Pay any amount');
    expect(linkCardPrice(view({ availability: 'expired' }))).toBeNull();
  });
});
