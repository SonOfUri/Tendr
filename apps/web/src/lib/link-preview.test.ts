import { THEME_PRESETS, type PublicPaymentLinkView } from '@tendr/contracts';
import { describe, expect, it, vi } from 'vitest';
import { tendrShopperTheme } from './checkout/brand';
import { linkCardColors } from './link-card';
import { linkCardPrice, linkDescription, linkTheme } from './link-preview';

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
    expect(linkCardPrice(view({}))).toBe('NGN 25,000');
    expect(linkCardPrice(view({ currency: 'USD', amount: '15.20' }))).toBe('$15.20');
    expect(linkCardPrice(view({ amount_type: 'open', amount: null }))).toBe('Pay any amount');
    expect(linkCardPrice(view({ availability: 'expired' }))).toBeNull();
  });
});

describe('the preview card follows the theme', () => {
  it('uses the theme palette background and accent; a broken theme gets Tendr default colours', () => {
    const fashion = {
      ...tendrShopperTheme('Kola Kicks'),
      id: 'thm_1',
      document: THEME_PRESETS.fashion.document('Kola Kicks'),
    };
    const colors = linkCardColors(linkTheme(view({ merchant: { name: 'Kola' }, theme: fashion })));
    expect(colors.background).toBe('#f7f3ee');
    expect(colors.accent).toBe('#1c1a17');
    expect(colors.onAccent).toBe('#ffffff');

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = view({ merchant: { name: 'Kola' }, theme: { nope: true } as never });
    expect(linkCardColors(linkTheme(broken))).toMatchObject({
      background: '#080d1b',
      text: '#ffffff',
    });
    expect(linkDescription({ ...broken, title: 'Tee' }, false)).toContain('Kola');
    vi.restoreAllMocks();
  });
});
