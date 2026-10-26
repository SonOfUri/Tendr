import { describe, expect, it } from 'vitest';
import { GET } from '@/app/v1/plugins/woocommerce/update.json/route';
import placeholder from '../../public/downloads/woocommerce/manifest.json';
import { downloadPath, updateFeed, updateFeedResponse, type PluginManifest } from './plugin-update';

const SHA = 'a'.repeat(64);
const manifest: PluginManifest = {
  version: '1.2.3',
  file: 'tendr-pay-with-crypto-1.2.3.zip',
  sha256: SHA,
  requires: '6.4',
  tested: '6.8',
  requires_php: '8.0',
};

describe('update.json', () => {
  it('update.json reflects manifest', async () => {
    expect(updateFeed(manifest, 'https://usetendr.tech')).toEqual({
      version: '1.2.3',
      download_url: 'https://usetendr.tech/downloads/woocommerce/tendr-pay-with-crypto-1.2.3.zip',
      sha256: SHA,
      requires: '6.4',
      tested: '6.8',
      requires_php: '8.0',
    });
    const res = updateFeedResponse(manifest, 'https://usetendr.tech/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ version: '1.2.3', sha256: SHA });
  });

  it('has no feed for an unpublished or malformed manifest', () => {
    expect(updateFeed({ ...manifest, version: '0.0.0' }, 'https://usetendr.tech')).toBeNull();
    expect(updateFeed({ ...manifest, file: null }, 'https://usetendr.tech')).toBeNull();
    expect(updateFeed({ ...manifest, file: '../etc/passwd' }, 'https://usetendr.tech')).toBeNull();
    expect(updateFeed({ ...manifest, sha256: 'nope' }, 'https://usetendr.tech')).toBeNull();
    expect(downloadPath({ ...manifest, version: '0.0.0' })).toBeNull();
    expect(downloadPath(manifest)).toBe('/downloads/woocommerce/tendr-pay-with-crypto-1.2.3.zip');
  });

  it('the placeholder manifest is 0.0.0 and the route answers 404', async () => {
    expect(placeholder.version).toBe('0.0.0');
    const res = GET();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
