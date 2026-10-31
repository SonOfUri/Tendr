import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { HideOnCheckout } = await import('./HideOnCheckout');

function shown(path: string): boolean {
  pathname = path;
  return renderToStaticMarkup(<HideOnCheckout>chrome</HideOnCheckout>) === 'chrome';
}

describe('HideOnCheckout', () => {
  it.each([
    '/pay/ses_1',
    '/ses_1',
    '/ses_1/refund-address',
    '/pay/acme/coffee',
    '/acme/coffee',
    '/acme/coffee/qr',
    '/preview/theme/t1',
    '/',
    '/demo',
  ])('hides the site chrome on %s', (path) => {
    expect(shown(path)).toBe(false);
  });

  it.each(['/dashboard', '/login', '/privacy'])('shows it on %s', (path) => {
    expect(shown(path)).toBe(true);
  });
});
