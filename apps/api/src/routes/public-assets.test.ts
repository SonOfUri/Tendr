import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryObjectStore, type ObjectStore } from '../storage/object-store.js';
import { publicAssetRoutes } from './public-assets.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(store: ObjectStore) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code((error as { status?: number }).status ?? 500)
      .send({ error: error instanceof Error ? error.message : 'Unexpected error' }),
  );
  await app.register(publicAssetRoutes, { store });
  await app.ready();
  return app;
}

describe('private bucket public assets', () => {
  it('serves images and fonts with safe types and cache headers, including HEAD', async () => {
    const store = memoryObjectStore();
    await store.put('assets/mer_1/tasset_1.woff2', Buffer.from('font'), 'font/woff2');
    const app = await setup(store);
    const response = await app.inject('/v1/assets/assets/mer_1/tasset_1.woff2');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('font');
    expect(response.headers['content-type']).toBe('font/woff2');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toContain('immutable');
    const head = await app.inject({
      method: 'HEAD',
      url: '/v1/assets/assets/mer_1/tasset_1.woff2',
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it('never reads arbitrary keys, credentials, traversal paths or HTML', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const app = await setup({ put: async () => {}, delete: async () => {}, get });
    for (const key of [
      'credentials.json',
      '.env',
      'assets/mer_1/page.html',
      'assets/mer_1/..%2Fsecret.png',
      'private/mer_1/a.png',
      'assets/mer_1/a.png%00',
    ]) {
      const response = await app.inject(`/v1/assets/${key}`);
      expect(response.statusCode).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('returns 404 for missing assets and mismatched MIME types', async () => {
    const store = memoryObjectStore();
    await store.put('assets/mer_1/a.svg', Buffer.from('<script>bad</script>'), 'text/html');
    const app = await setup(store);
    expect((await app.inject('/v1/assets/assets/mer_1/missing.png')).statusCode).toBe(404);
    expect((await app.inject('/v1/assets/assets/mer_1/a.svg')).statusCode).toBe(404);
  });

  it('uses conditional reads and a shorter cache for product images that can change', async () => {
    const get = vi.fn().mockResolvedValue({
      body: Buffer.from('image'),
      contentType: 'image/webp',
      etag: '"version-1"',
    });
    const app = await setup({ put: async () => {}, delete: async () => {}, get });
    const url = '/v1/assets/products/mer_1/hash.webp';
    const response = await app.inject(url);
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(response.headers.etag).toBe('"version-1"');
    expect(
      (await app.inject({ url, headers: { 'if-none-match': '"version-1"' } })).statusCode,
    ).toBe(304);
  });
});
