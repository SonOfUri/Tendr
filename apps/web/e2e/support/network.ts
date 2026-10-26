import type { BrowserContext } from '@playwright/test';

/**
 * No real network in the end-to-end tests: every request that isn't to a local test server is
 * aborted (Google Fonts, Reown / WalletConnect, anything else).
 */
export async function blockExternal(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort('blockedbyclient'),
  );
}
