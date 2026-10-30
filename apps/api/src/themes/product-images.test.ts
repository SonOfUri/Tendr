import type { LookupAddress } from 'node:dns';
import type { Event, Merchant } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import {
  SafeFetchError,
  setSafeFetchResolver,
  type safeFetch,
  type SafeFetchResult,
} from '../lib/safe-fetch.js';
import { memoryObjectStore } from '../storage/object-store.js';
import { clearEventHandlers, getEventHandler, handlerNamesFor } from '../jobs/handlers.js';
import { createMerchant, createRow, minimalSession, resetDb } from '../test/helpers.js';
import { cacheProductImages, registerProductImageHandler } from './product-images.js';

type Fetch = typeof safeFetch;

/** A fake fetch answering from `bodies` (URL → bytes); anything else is a 404. */
function fakeFetch(bodies: Record<string, Buffer>) {
  return vi.fn<Fetch>(async (url) => {
    const body = bodies[url];
    if (!body) throw new SafeFetchError('bad_status', 'The server answered 404', 404);
    return { status: 200, contentType: 'image/png', body, finalUrl: url } as SafeFetchResult;
  });
}

describe('product images', () => {
  let merchant: Merchant;
  let store: ReturnType<typeof memoryObjectStore>;
  let png: Buffer;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant();
    store = memoryObjectStore();
    png = await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#d94f2b' } })
      .png()
      .toBuffer();
  });
  afterEach(() => {
    setSafeFetchResolver(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const rows = () =>
    prisma.productImage.findMany({
      where: { merchantId: merchant.id },
      orderBy: { sourceUrl: 'asc' },
    });

  it('caches resized webp and marks ok', async () => {
    const url = 'https://shop.example/p/shirt.png?v=2';
    const missing = 'https://shop.example/p/gone.png';
    const fetch = fakeFetch({ [url]: png });
    await cacheProductImages(merchant.id, [url, url, missing], { store, fetch });

    const hash = sha256(url);
    const key = `products/${merchant.id}/${hash}.webp`;
    const stored = store.objects.get(key);
    expect(stored?.contentType).toBe('image/webp');
    const meta = await sharp(stored!.body).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 512, height: 256 });

    const [gone, ok] = await rows();
    expect(ok).toMatchObject({
      urlHash: hash,
      sourceUrl: url,
      status: 'ok',
      key,
      url: `${env().TENDR_ASSET_ORIGIN}/${key}`,
    });
    expect(ok!.fetchedAt).toBeInstanceOf(Date);
    expect(gone).toMatchObject({ sourceUrl: missing, status: 'failed', url: null });
    // The duplicate URL is fetched once; every fetch uses the brand-fetch limits.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
    });
  });

  it('product image fetch refuses private hosts', async () => {
    setSafeFetchResolver(async (): Promise<LookupAddress[]> => [
      { address: '10.0.0.7', family: 4 },
    ]);
    const url = 'https://internal.example/p.png';
    // The real safeFetch: the host resolves to a private address, so nothing is ever requested.
    await cacheProductImages(merchant.id, [url], { store });
    expect(store.objects.size).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({ sourceUrl: url, status: 'failed', url: null, key: null });
  });

  it('svg product image is failed', async () => {
    const url = 'https://shop.example/p.svg';
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await cacheProductImages(merchant.id, [url], { store, fetch: fakeFetch({ [url]: svg }) });
    expect(store.objects.size).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: 'failed', url: null });
  });

  it('does not refetch within 7 days', async () => {
    const url = 'https://shop.example/p.png';
    const fetch = fakeFetch({ [url]: png });
    await cacheProductImages(merchant.id, [url], { store, fetch });
    await cacheProductImages(merchant.id, [url], { store, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Eight days later the cached copy is refreshed.
    await prisma.productImage.updateMany({
      where: { merchantId: merchant.id },
      data: { fetchedAt: new Date(Date.now() - 8 * 24 * 3600_000) },
    });
    await cacheProductImages(merchant.id, [url], { store, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await rows())[0]).toMatchObject({ status: 'ok' });
  });

  it('session.created handler caches the line item images', async () => {
    const url = 'https://shop.example/p.png';
    const session = await prisma.session.create({
      data: minimalSession({
        merchantId: merchant.id,
        livemode: false,
        lineItems: [
          { name: 'Shirt', quantity: 1, unit_amount: '10.00', image_url: url },
          { name: 'Gift wrap', quantity: 1, unit_amount: '1.00' },
        ],
      }),
    });
    clearEventHandlers();
    const fetch = fakeFetch({ [url]: png });
    registerProductImageHandler({ store, fetch });
    const [name] = handlerNamesFor('session.created');
    const event = await createRow('Event', merchant.id, false, { aggregateId: session.id });
    await getEventHandler('session.created', name!)!(event as unknown as Event);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ sourceUrl: url, status: 'ok' });
    clearEventHandlers();
  });
});
