// Product images (spec §6): a session's line items may name an `image_url` on the store's site.
// Shoppers never load it from there. When a session is created, Tendr fetches each image through
// `safeFetch` (public https only, 5 s, 2 MB, ≤ 3 redirects), accepts only raster types judged by
// their bytes (PNG, JPEG, WebP, GIF; never SVG), re-encodes it with sharp to a WebP that fits
// 512×512, and stores it at `products/<merchantId>/<urlHash>.webp` on the asset origin. The
// shopper view shows an image only once its `ProductImage` row is `ok`.
//
// `urlHash` is the sha256 hex of the exact `image_url` string as stored on the session (no
// normalisation), per merchant. `url` is only ever an asset-origin URL.
import { LineItemSchema, LINE_ITEMS_MAX } from '@tendr/contracts';
import sharp from 'sharp';
import { scopedDb } from '../db/scoped.js';
import { env } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { registerEventHandler } from '../jobs/handlers.js';
import { assetUrl, createObjectStore, type ObjectStore } from '../storage/object-store.js';
import { RASTER_MAX_BYTES, RASTER_MAX_DIMENSION } from './assets.js';
import { sniffAsset, type AssetMime } from './sniff.js';

export type ProductImageDeps = { store: ObjectStore; fetch?: typeof safeFetch };

/** A cached image is not fetched again for this long. */
export const PRODUCT_IMAGE_TTL_MS = 7 * 24 * 3600_000;
/** The stored image fits inside this square. */
export const PRODUCT_IMAGE_SIZE = 512;

export const PRODUCT_IMAGE_FETCH = {
  timeoutMs: 5_000,
  maxBytes: RASTER_MAX_BYTES,
  maxRedirects: 3,
  accept: 'image/png, image/jpeg, image/webp, image/gif',
} as const;

const RASTER: readonly AssetMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** The image as a WebP fitting 512×512, or null when it is not a readable raster image. */
async function reencode(buf: Buffer): Promise<Buffer | null> {
  const sniffed = sniffAsset(buf);
  if (!sniffed || !RASTER.includes(sniffed.mime)) return null;
  try {
    return await sharp(buf, {
      limitInputPixels: RASTER_MAX_DIMENSION * RASTER_MAX_DIMENSION,
      failOn: 'error',
    })
      .rotate()
      .resize(PRODUCT_IMAGE_SIZE, PRODUCT_IMAGE_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Fetches, re-encodes and stores each distinct URL (at most 50), skipping ones cached `ok` in the
 * last 7 days. Each row ends `ok` (with its asset-origin `url`) or `failed`; a failure never
 * throws, so one bad image does not hold up the others.
 */
export async function cacheProductImages(
  merchantId: string,
  urls: string[],
  deps: ProductImageDeps,
): Promise<void> {
  const fetch = deps.fetch ?? safeFetch;
  // ProductImage is shared by both modes; the mode given here only satisfies the scoped client.
  const db = scopedDb({ merchantId, livemode: false });
  const fresh = Date.now() - PRODUCT_IMAGE_TTL_MS;
  for (const sourceUrl of [...new Set(urls)].slice(0, LINE_ITEMS_MAX)) {
    const urlHash = sha256(sourceUrl);
    const row = await db.productImage.upsert({
      where: { merchantId_urlHash: { merchantId, urlHash } },
      create: { id: newId('pimg'), merchantId, urlHash, sourceUrl, status: 'pending' },
      update: {},
    });
    if (row.status === 'ok' && row.fetchedAt && row.fetchedAt.getTime() > fresh) continue;

    let body: Buffer | null = null;
    let reason = 'not a PNG, JPEG, WebP or GIF image';
    try {
      body = await reencode((await fetch(sourceUrl, PRODUCT_IMAGE_FETCH)).body);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    const key = `products/${merchantId}/${urlHash}.webp`;
    if (body) {
      try {
        await deps.store.put(key, body, 'image/webp');
      } catch (err) {
        reason = `store failed: ${String(err)}`;
        body = null;
      }
    }
    if (!body) {
      log('warn', 'product image not cached', { merchantId, imageId: row.id, reason });
      await db.productImage.update({
        where: { id: row.id },
        data: { status: 'failed', key: null, url: null, fetchedAt: new Date() },
      });
      continue;
    }
    await db.productImage.update({
      where: { id: row.id },
      data: { status: 'ok', key, url: assetUrl(key), fetchedAt: new Date() },
    });
  }
}

export const PRODUCT_IMAGE_HANDLER = 'product-images.cache';

/**
 * On `session.created`, caches the images the session's line items name. `deps` overrides the
 * object store (default: the one `ASSET_STORE_DRIVER` names) and the fetch, for tests.
 */
export function registerProductImageHandler(deps?: Partial<ProductImageDeps>): void {
  let store = deps?.store;
  registerEventHandler('session.created', PRODUCT_IMAGE_HANDLER, async (event) => {
    if (!event.merchantId || event.livemode === null) return;
    const session = await scopedDb({
      merchantId: event.merchantId,
      livemode: event.livemode,
    }).session.findFirst({ where: { id: event.aggregateId }, select: { lineItems: true } });
    const parsed = LineItemSchema.array().safeParse(session?.lineItems ?? []);
    if (!parsed.success) return;
    const urls = parsed.data.flatMap((i) => (i.image_url ? [i.image_url] : []));
    if (urls.length === 0) return;
    store ??= createObjectStore(env());
    await cacheProductImages(event.merchantId, urls, { store, fetch: deps?.fetch });
  });
}
