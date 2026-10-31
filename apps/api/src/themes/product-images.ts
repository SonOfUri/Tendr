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
import type { Queue } from 'bullmq';
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

export type ProductImageDeps = {
  store: ObjectStore;
  fetch?: typeof safeFetch;
  /** Overrides `PRODUCT_IMAGE_JOB_BUDGET_MS` (tests). */
  budgetMs?: number;
};

/** A cached image is not fetched again for this long. */
export const PRODUCT_IMAGE_TTL_MS = 7 * 24 * 3600_000;
/** A failed image is not fetched again for this long. */
export const PRODUCT_IMAGE_RETRY_MS = 3600_000;
/** At most this many images of one job are fetched at once. */
export const PRODUCT_IMAGE_PARALLELISM = 3;
/**
 * A job starts no new fetch after this long; the URLs it did not reach stay `pending` and are
 * fetched when a later session names them.
 */
export const PRODUCT_IMAGE_JOB_BUDGET_MS = 30_000;
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
 * Fetches, re-encodes and stores each distinct URL (at most 50), three at a time, skipping ones
 * cached `ok` in the last 7 days or `failed` in the last hour. No new fetch starts once the job
 * has run for `PRODUCT_IMAGE_JOB_BUDGET_MS`; the rest stay `pending`. Each fetched row ends `ok`
 * (with its asset-origin `url`) or `failed`; a failure never throws, so one bad image does not
 * hold up the others.
 */
export async function cacheProductImages(
  merchantId: string,
  urls: string[],
  deps: ProductImageDeps,
): Promise<void> {
  const fetch = deps.fetch ?? safeFetch;
  const deadline = Date.now() + (deps.budgetMs ?? PRODUCT_IMAGE_JOB_BUDGET_MS);
  // ProductImage is shared by both modes; the mode given here only satisfies the scoped client.
  const db = scopedDb({ merchantId, livemode: false });

  const due: Array<{ id: string; sourceUrl: string; urlHash: string }> = [];
  for (const sourceUrl of [...new Set(urls)].slice(0, LINE_ITEMS_MAX)) {
    const urlHash = sha256(sourceUrl);
    const row = await db.productImage.upsert({
      where: { merchantId_urlHash: { merchantId, urlHash } },
      create: { id: newId('pimg'), merchantId, urlHash, sourceUrl, status: 'pending' },
      update: {},
    });
    const age = row.fetchedAt ? Date.now() - row.fetchedAt.getTime() : Infinity;
    if (row.status === 'ok' && age < PRODUCT_IMAGE_TTL_MS) continue;
    if (row.status === 'failed' && age < PRODUCT_IMAGE_RETRY_MS) continue;
    due.push({ id: row.id, sourceUrl, urlHash });
  }

  const cacheOne = async ({ id, sourceUrl, urlHash }: (typeof due)[number]): Promise<void> => {
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
      log('warn', 'product image not cached', { merchantId, imageId: id, reason });
      await db.productImage.update({
        where: { id },
        data: { status: 'failed', key: null, url: null, fetchedAt: new Date() },
      });
      return;
    }
    await db.productImage.update({
      where: { id },
      data: { status: 'ok', key, url: assetUrl(key), fetchedAt: new Date() },
    });
  };

  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < due.length && Date.now() < deadline) {
      await cacheOne(due[next++]!);
    }
  };
  await Promise.all(Array.from({ length: PRODUCT_IMAGE_PARALLELISM }, lane));
  if (next < due.length) {
    log('info', 'product image job out of time', { merchantId, left: due.length - next });
  }
}

export const PRODUCT_IMAGE_HANDLER = 'product-images.cache';

/**
 * Product images run on their own queue and worker, so slow store sites never delay the shared
 * events queue (webhooks, notices).
 */
export const PRODUCT_IMAGES_QUEUE = 'tendr-product-images';
export const CACHE_PRODUCT_IMAGES_JOB = 'cache-product-images';
/** Jobs the product-images worker runs at once. */
export const PRODUCT_IMAGES_CONCURRENCY = 2;

export interface CacheProductImagesJobData {
  merchantId: string;
  urls: string[];
}

let imageQueue: Pick<Queue, 'add'> | null = null;

/** The worker sets the product-images queue at start (null clears it). */
export function setProductImageQueue(q: Pick<Queue, 'add'> | null): void {
  imageQueue = q;
}

/**
 * On `session.created`, queues a job caching the images the session's line items name. Without a
 * queue (a process that is not the worker) the event is skipped: the images stay uncached until a
 * later session names them.
 */
export function registerProductImageHandler(): void {
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
    if (!imageQueue) {
      log('warn', 'product image queue not set; skipping', { eventId: event.id });
      return;
    }
    await imageQueue.add(
      CACHE_PRODUCT_IMAGES_JOB,
      { merchantId: event.merchantId, urls } satisfies CacheProductImagesJobData,
      {
        jobId: `pimg__${event.id}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      },
    );
  });
}

let defaultStore: ObjectStore | undefined;

/**
 * Runs one product-images job. `deps` overrides the object store (default: the one
 * `ASSET_STORE_DRIVER` names), the fetch and the budget, for tests.
 */
export async function runProductImageJob(
  data: CacheProductImagesJobData,
  deps?: Partial<ProductImageDeps>,
): Promise<void> {
  const store = deps?.store ?? (defaultStore ??= createObjectStore(env()));
  await cacheProductImages(data.merchantId, data.urls, { ...deps, store });
}
