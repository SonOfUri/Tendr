import { THEME_PRESETS } from '@tendr/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { tendrShopperTheme } from '@/lib/checkout/brand';
import { fetchPreview, PreviewBody, PREVIEW_RIBBON, type PreviewRead } from './ThemePreview';

function read(over: Partial<PreviewRead> = {}): PreviewRead {
  return {
    preview: true,
    opts: { sample: 'checkout', scheme: 'light', viewport: 'phone' },
    theme: {
      ...tendrShopperTheme('Kola Kicks'),
      id: 'thm_draft',
      version: 1,
      document: THEME_PRESETS.fashion.document('Kola Kicks'),
      payee: 'Lagos Leather Co.',
      trading_as: 'Kola Kicks',
    },
    sample: {
      kind: 'checkout',
      amount: '49.00',
      amount_currency: 'USD',
      line_items: [
        {
          name: 'Linen shirt',
          quantity: 1,
          unit_amount: '29.00',
          description: 'Sample item',
          image_url: 'http://localhost:3100/preview/sample-shirt.webp',
        },
        {
          name: 'Canvas tote',
          quantity: 1,
          unit_amount: '20.00',
          description: 'Sample item',
          image_url: 'http://localhost:3100/preview/sample-tote.webp',
        },
      ],
    },
    ...over,
  };
}

describe('theme preview page', () => {
  it('renders the draft with the sample cart, a ribbon, and a Pay button that does nothing', () => {
    const html = renderToStaticMarkup(<PreviewBody read={read()} />);
    expect(html).toContain(PREVIEW_RIBBON);
    expect(html).toContain('Kola Kicks');
    expect(html).toContain('Linen shirt');
    expect(html).toContain('$49.00');
    expect(html).toMatch(/<button type="button" class="pay-button" disabled=""/);
    expect(html).toContain('data-viewport="phone"');
    expect(html).toContain('data-scheme="light"');
    // No difference line: the sample lines add up to the amount.
    expect(html).not.toContain('Shipping, tax or discounts');
  });

  it('draws a link sample with the link title in the order summary', () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        read={read({
          opts: { sample: 'link', scheme: 'dark', viewport: 'desktop' },
          sample: {
            kind: 'link',
            amount: '25000',
            amount_currency: 'NGN',
            line_items: [],
            link: { title: 'Sample payment link', description: 'Your link page.' },
          },
        })}
      />,
    );
    expect(html).toContain('Sample payment link');
    expect(html).toContain('₦25,000');
    expect(html).toContain(PREVIEW_RIBBON);
  });

  it('an unknown or expired token reads as null, never throws', async () => {
    const notFound = vi.fn(async () => new Response('{}', { status: 404 }));
    expect(await fetchPreview('x'.repeat(43), notFound as unknown as typeof fetch)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchPreview('x'.repeat(43), down as unknown as typeof fetch)).toBeNull();
    const call = (notFound.mock.calls[0] as unknown as [string, RequestInit])!;
    expect(call[0]).toMatch(/\/v1\/themes\/preview\/x{43}$/);
    expect(call[1].credentials).toBe('omit');
  });
});
