import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp';

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  ) as Record<string, string[]>;

describe('contentSecurityPolicy', () => {
  it('is the strict signing-page policy in production', () => {
    const d = directives(
      contentSecurityPolicy({ nonce: 'abc', apiBaseUrl: 'https://api.usetendr.tech/', dev: false }),
    );
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['script-src']).toEqual(["'self'", "'nonce-abc'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['connect-src']).toEqual(["'self'", 'https://api.usetendr.tech']);
    // No script host, no eval, no inline script without the nonce.
    expect(d['script-src']).not.toContain("'unsafe-eval'");
    expect(d['script-src']).not.toContain("'unsafe-inline'");
  });

  it('allows eval and hot reload only in development', () => {
    const d = directives(
      contentSecurityPolicy({ nonce: 'n', apiBaseUrl: 'http://localhost:4000', dev: true }),
    );
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['connect-src']).toEqual(["'self'", 'http://localhost:4000', 'ws:']);
  });
});
