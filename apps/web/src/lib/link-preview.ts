// What a payment link's preview card says (spec §4.1), shared by the page metadata and the image.
import type { PublicPaymentLinkView } from '@tendr/contracts';
import { themeDisplayName } from './checkout/brand';
import { formatLinkAmount, linkFractionDigits } from './payment-links-client';

/** The price line, or null when the link no longer takes payments (no price on its card). */
export function linkPriceText(view: PublicPaymentLinkView): string | null {
  if (view.availability !== 'available') return null;
  if (view.amount_type === 'open' || view.amount === null) return 'Pay any amount';
  return formatLinkAmount(view.amount, view.currency, view.minor_units);
}

/** `og:description`: "<merchant> · <price>", prefixed "Test · " on a test link. */
export function linkDescription(view: PublicPaymentLinkView, test: boolean): string {
  const price = linkPriceText(view);
  const name = themeDisplayName(view.theme);
  const text = price ? `${name} · ${price}` : name;
  return test ? `Test · ${text}` : text;
}

/**
 * The price line for the image: the card's font has no glyph for symbols like ₦ or ₹, so a
 * symbol outside Latin-1 (and €) is replaced by the ISO code ("NGN 25,000.00").
 */
export function linkCardPrice(view: PublicPaymentLinkView): string | null {
  const price = linkPriceText(view);
  if (price === null || view.amount === null || view.amount_type === 'open') return price;
  if (!/[^\u0000-ÿ€]/.test(price)) return price;
  const digits = linkFractionDigits(view.amount, view.minor_units);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: view.currency,
      currencyDisplay: 'code',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
      .format(view.amount as unknown as number)
      .replace(/\u00A0/g, ' ');
  } catch {
    return `${view.amount} ${view.currency}`;
  }
}

/** The query that picks the test link (empty for a live one). */
export function modeQuery(test: boolean): string {
  return test ? '?mode=test' : '';
}
