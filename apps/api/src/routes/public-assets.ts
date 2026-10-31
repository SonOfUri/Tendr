import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../lib/errors.js';
import { ASSET_CACHE_CONTROL, type ObjectStore } from '../storage/object-store.js';

export const PUBLIC_ASSET_PREFIX = '/v1/assets/';
const KEY =
  /^(assets|products)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif|webp|svg|woff2)$/;
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
};

/** Publish only Tendr's validated image/font namespaces, never arbitrary bucket contents. */
export const publicAssetRoutes: FastifyPluginAsync<{ store: ObjectStore }> = async (
  app,
  { store },
) => {
  if (!store.get) throw new Error('ASSET_PUBLIC_PROXY requires a readable object store');
  app.get<{ Params: { '*': string } }>(
    `${PUBLIC_ASSET_PREFIX}*`,
    // Asset requests still use the global per-IP limiter; they do not share the 60/min auth limit.
    { config: { auth: 'public', publicLimit: 'route' } },
    async (request, reply) => {
      const key = request.params['*'];
      const match = KEY.exec(key);
      if (!match || key.length > 300) throw notFound('Asset not found');
      const asset = await store.get!(key);
      const contentType = TYPES[match[2]!];
      if (!asset || asset.contentType !== contentType) throw notFound('Asset not found');
      reply.header(
        'cache-control',
        key.startsWith('products/') ? 'public, max-age=3600' : ASSET_CACHE_CONTROL,
      );
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cross-origin-resource-policy', 'cross-origin');
      reply.header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      if (asset.etag) {
        reply.header('etag', asset.etag);
        if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send();
      }
      return reply.type(contentType!).send(asset.body);
    },
  );
};
