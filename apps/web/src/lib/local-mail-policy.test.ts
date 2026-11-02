import { describe, expect, it } from 'vitest';
import { localMailEnabled, localMailLink, localMailRequestAllowed } from './local-mail-policy';

const local = {
  NODE_ENV: 'development',
  API_CONSOLE_ENABLED: 'true',
  MAIL_DRIVER: 'log',
  WEB_URL: 'http://localhost:3300',
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4300',
};

describe('local mail isolation', () => {
  it('requires local development, explicit console opt-in, and log mail', () => {
    expect(localMailEnabled(local)).toBe(true);
    for (const changed of [
      { NODE_ENV: 'production' },
      { API_CONSOLE_ENABLED: undefined },
      { API_CONSOLE_ENABLED: 'false' },
      { MAIL_DRIVER: 'resend' },
      { WEB_URL: 'https://app.usetendr.tech' },
      { NEXT_PUBLIC_API_BASE_URL: 'https://api.usetendr.tech' },
      { WEB_URL: 'not-a-url' },
    ])
      expect(localMailEnabled({ ...local, ...changed })).toBe(false);
  });

  it('rejects cross-origin requests and unexpected hosts', () => {
    const url = 'http://localhost:3300/api/dev-mail';
    expect(localMailRequestAllowed(new Request(url), local)).toBe(true);
    expect(
      localMailRequestAllowed(
        new Request(url, { headers: { origin: local.WEB_URL, 'sec-fetch-site': 'same-origin' } }),
        local,
      ),
    ).toBe(true);
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'http://localhost:9999' },
      { host: 'evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ] as Record<string, string>[])
      expect(localMailRequestAllowed(new Request(url, { headers }), local)).toBe(false);
    expect(localMailRequestAllowed(new Request('https://evil.example/api/dev-mail'), local)).toBe(
      false,
    );
  });

  it('only turns links to the local app into actions', () => {
    expect(localMailLink('http://localhost:3300/verify?token=test-only', local.WEB_URL)).toContain(
      '/verify?',
    );
    for (const url of [
      'javascript:alert(1)',
      'https://evil.example/verify',
      'http://localhost:9999/verify',
      'http://user:password@localhost:3300/verify',
    ])
      expect(localMailLink(url, local.WEB_URL)).toBeNull();
  });
});
