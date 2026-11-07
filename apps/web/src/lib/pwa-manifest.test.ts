import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../public');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; purpose: string }[];
  shortcuts: { url: string }[];
};

describe('web app manifest', () => {
  it('installs as the merchant app and opens on the dashboard', () => {
    expect(manifest.name).toBe('Tendr');
    expect(manifest.short_name).toBe('Tendr');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/dashboard');
    expect(manifest.scope).toBe('/');
    expect(manifest.theme_color).toBe('#070707');
    expect(manifest.background_color).toBe('#070707');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);

    expect(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose.includes('any'))).toBe(
      true,
    );
    expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose.includes('any'))).toBe(
      true,
    );
    expect(manifest.icons.some((icon) => icon.purpose.includes('maskable'))).toBe(true);
    for (const icon of manifest.icons) {
      expect(statSync(resolve(root, icon.src.replace(/^\//, ''))).size).toBeGreaterThan(500);
    }

    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      '/dashboard/payment-links',
      '/dashboard/payments',
    ]);
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.url.startsWith(manifest.scope)).toBe(true);
    }
  });
});
