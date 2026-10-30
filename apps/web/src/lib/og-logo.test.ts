import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeLogo } from './og-logo';

const ORIGIN = 'https://assets.usetendr.tech';
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubEnv('TENDR_ASSET_ORIGIN', ORIGIN);
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchSpy.mockReset();
});

const image = (bytes = 10, type = 'image/png') =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': type } });

describe('safeLogo', () => {
  it.each([
    ['http scheme', 'http://assets.usetendr.tech/l.png'],
    ['other origin', 'https://example.com/l.png'],
    ['asset origin as a subdomain of evil', 'https://assets.usetendr.tech.evil.example/l.png'],
    ['userinfo trick', 'https://assets.usetendr.tech@evil.example/l.png'],
    ['metadata ip', 'http://169.254.169.254/latest/meta-data'],
    ['not a url', 'nope'],
    ['empty', ''],
  ])('refuses %s without fetching', async (_n, url) => {
    expect(await safeLogo(url)).toBeNull();
    expect(await safeLogo(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses everything when TENDR_ASSET_ORIGIN is unset', async () => {
    vi.stubEnv('TENDR_ASSET_ORIGIN', '');
    expect(await safeLogo(`${ORIGIN}/l.png`)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches from the asset origin with a timeout and no redirects', async () => {
    fetchSpy.mockResolvedValue(image(10));
    const out = await safeLogo(`${ORIGIN}/l.png`);
    expect(out?.byteLength).toBe(10);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null on a redirect (fetch rejects), a non-image type, or more than 1 MB', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('redirect'));
    expect(await safeLogo(`${ORIGIN}/l.png`)).toBeNull();
    fetchSpy.mockResolvedValueOnce(image(10, 'text/html'));
    expect(await safeLogo(`${ORIGIN}/l.png`)).toBeNull();
    fetchSpy.mockResolvedValueOnce(image(1_000_001));
    expect(await safeLogo(`${ORIGIN}/l.png`)).toBeNull();
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await safeLogo(`${ORIGIN}/l.png`)).toBeNull();
  });
});
