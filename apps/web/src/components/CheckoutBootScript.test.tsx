import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { CheckoutBootScript } = await import('./CheckoutBootScript');

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';

function loads(path: string): boolean {
  pathname = path;
  return renderToStaticMarkup(<CheckoutBootScript />).includes('/checkout-boot.js');
}

describe('CheckoutBootScript', () => {
  it('loads on the checkout page in either form', () => {
    expect(loads(`/${SESSION}`)).toBe(true);
    expect(loads(`/pay/${SESSION}`)).toBe(true);
  });

  it('not on sub-pages, links or other pages', () => {
    expect(loads(`/${SESSION}/refund-address`)).toBe(false);
    expect(loads('/acme/coffee')).toBe(false);
    expect(loads('/dashboard')).toBe(false);
  });
});
