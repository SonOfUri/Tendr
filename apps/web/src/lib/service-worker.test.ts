// public/sw.js: which requests the service worker answers. It must never touch the checkout
// (`/pay/…`) or a framed navigation: re-fetching a navigation from the worker drops its
// `Sec-Fetch-Dest: iframe`, so the middleware would skip the frame-origins lookup and send
// `frame-ancestors 'self'`, and every store's modal or widget would be refused in a browser that
// had ever opened the tendr site (found by the WooCommerce e2e).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type FetchHandler = (event: {
  request: { method: string; url: string; mode: string; destination: string };
  respondWith: (r: unknown) => void;
}) => void;

/** Loads sw.js in a sandbox and returns its fetch handler. */
function fetchHandler(): FetchHandler {
  const handlers: Record<string, FetchHandler> = {};
  const self = {
    addEventListener: (type: string, fn: FetchHandler) => {
      handlers[type] = fn;
    },
  };
  runInNewContext(readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8'), {
    self,
    URL,
    caches: { match: () => Promise.resolve(undefined) },
    fetch: () => Promise.resolve(undefined),
  });
  return handlers.fetch!;
}

/** Whether the worker answers the request (else the browser fetches it as usual). */
function answers(request: { url: string; mode?: string; destination?: string }): boolean {
  let responded = false;
  fetchHandler()({
    request: { method: 'GET', mode: 'navigate', destination: 'document', ...request },
    respondWith: () => {
      responded = true;
    },
  });
  return responded;
}

describe('service worker', () => {
  it('never answers a framed navigation (the checkout modal and widget)', () => {
    expect(
      answers({ url: 'https://usetendr.tech/pay/ses_X?embed=modal', destination: 'iframe' }),
    ).toBe(false);
    expect(answers({ url: 'https://usetendr.tech/dashboard', destination: 'iframe' })).toBe(false);
  });

  it('never answers the checkout, even as a top-level page', () => {
    expect(answers({ url: 'https://usetendr.tech/pay/ses_X' })).toBe(false);
    // The root form the pay host serves.
    expect(answers({ url: 'https://pay.usetendr.tech/ses_1' })).toBe(false);
    expect(answers({ url: 'https://pay.usetendr.tech/pay/ses_1' })).toBe(false);
    expect(answers({ url: 'https://pay.usetendr.tech/ses_1/refund-address' })).toBe(false);
  });

  it('still answers top-level navigations elsewhere (offline fallback) and shell assets', () => {
    expect(answers({ url: 'https://usetendr.tech/dashboard' })).toBe(true);
    expect(
      answers({
        url: 'https://usetendr.tech/icons/icon-192.png',
        mode: 'no-cors',
        destination: 'image',
      }),
    ).toBe(true);
  });
});
