import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';

const PAY_DIR = resolve(__dirname, '../../app/pay');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('shopper screens', () => {
  it('use plain words: no "intent", "solver" or "gas"', () => {
    const found = files(PAY_DIR).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/\b(intents?|solvers?|gas)\b/gi)].map(
        (m) => `${f}: ${m[0]}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe('next.config headers for /pay', () => {
  it('sets no X-Frame-Options for the checkout (CSP frame-ancestors governs framing)', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const pay = rules.filter((r) => r.source.startsWith('/pay'));
    expect(pay.length).toBeGreaterThan(0);
    for (const r of pay) {
      expect(r.headers.map((h) => h.key.toLowerCase())).not.toContain('x-frame-options');
    }
    // Every X-Frame-Options rule is for a non-checkout path.
    for (const r of rules) {
      if (r.headers.some((h) => h.key.toLowerCase() === 'x-frame-options')) {
        expect(r.source.startsWith('/pay')).toBe(false);
        expect(r.source).not.toBe('/:path*');
      }
    }
  });
});
