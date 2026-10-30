import { createHash } from 'node:crypto';
import type { Merchant } from '@prisma/client';
import { THEME_ASSET_MAX_PER_MERCHANT } from '@tendr/contracts';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedDb } from '../db/scoped.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { memoryObjectStore } from '../storage/object-store.js';
import { createMerchant, resetDb } from '../test/helpers.js';
import { deleteThemeAsset, listThemeAssets, uploadThemeAsset, type AssetCtx } from './assets.js';
import { createTheme, publishTheme, updateThemeDraft } from './themes.js';

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

const pngOf = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#d94f2b' } })
    .png()
    .toBuffer();

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const woff2Of = (size: number) => Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(size - 4)]);

describe('theme assets', () => {
  let merchant: Merchant;
  let store: ReturnType<typeof memoryObjectStore>;
  const ctxOf = (livemode = false): AssetCtx => ({
    merchantId: merchant.id,
    db: scopedDb({ merchantId: merchant.id, livemode }),
    store,
  });

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant({ name: 'Ada Fashion House' });
    store = memoryObjectStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('uploads png logo', async () => {
    const buf = await pngOf(64, 32);
    // The name says .jpg; the bytes decide.
    const a = await uploadThemeAsset(ctxOf(), { kind: 'logo', filename: 'logo.jpg', buf });
    expect(a).toMatchObject({
      object: 'theme_asset',
      kind: 'logo',
      mime: 'image/png',
      size_bytes: buf.length,
      checksum: createHash('sha256').update(buf).digest('hex'),
    });
    expect(a.id).toMatch(/^tasset_/);
    const key = `assets/${merchant.id}/${a.id}.png`;
    expect(a.url).toBe(`${env().TENDR_ASSET_ORIGIN}/${key}`);
    expect(store.objects.get(key)).toEqual({ body: buf, contentType: 'image/png' });
    const row = await prisma.themeAsset.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ key, merchantId: merchant.id, themeId: null, url: a.url });
    // Shared by both modes.
    const list = await listThemeAssets(ctxOf(true));
    expect(list.data.map((x) => x.id)).toEqual([a.id]);
  });

  it('rejects 2.1 MB image', async () => {
    const buf = Buffer.concat([PNG_MAGIC, Buffer.alloc(2_100_000 - PNG_MAGIC.length)]);
    const err = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'a.png', buf }),
    );
    expect(err.code).toBe('ASSET_INVALID');
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/2 MB/);
    expect(store.objects.size).toBe(0);
    expect(await prisma.themeAsset.count()).toBe(0);
  });

  it('rejects woff2 over 500 KB', async () => {
    const ok = await uploadThemeAsset(ctxOf(), {
      kind: 'font',
      filename: 'brand.woff2',
      buf: woff2Of(500 * 1024),
    });
    expect(ok.mime).toBe('font/woff2');
    const err = await rejection(
      uploadThemeAsset(ctxOf(), {
        kind: 'font',
        filename: 'b.woff2',
        buf: woff2Of(500 * 1024 + 1),
      }),
    );
    expect(err.code).toBe('ASSET_INVALID');
    expect(err.message).toMatch(/500 KB/);
    // Kinds take their own types: a font is not a logo, an image is not a font.
    const asLogo = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'logo', filename: 'x.woff2', buf: woff2Of(1024) }),
    );
    expect(asLogo.code).toBe('ASSET_INVALID');
    const asFont = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'font', filename: 'x.png', buf: await pngOf(4, 4) }),
    );
    expect(asFont.code).toBe('ASSET_INVALID');
  });

  it('rejects undecodable and oversized rasters', async () => {
    const broken = Buffer.concat([PNG_MAGIC, Buffer.from('not really a png')]);
    expect(
      (
        await rejection(
          uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'a.png', buf: broken }),
        )
      ).code,
    ).toBe('ASSET_INVALID');
    const wide = await pngOf(8001, 1);
    const err = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'wide.png', buf: wide }),
    );
    expect(err.code).toBe('ASSET_INVALID');
    expect(err.message).toMatch(/8000/);
    const html = Buffer.from('<html><body>hi</body></html>');
    expect(
      (await rejection(uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'a.png', buf: html })))
        .code,
    ).toBe('ASSET_INVALID');
  });

  it('strips script from svg and rejects foreignObject', async () => {
    const svg = [
      '<?xml version="1.0"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">',
      '<script>alert(document.cookie)</script>',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>',
      '<rect width="10" height="10" fill="url(#g)" onclick="steal()"/>',
      '<use href="#g"/><use xlink:href="https://evil.example/x.svg#a"/>',
      '<a href="javascript:alert(1)"><circle r="2" fill="url(https://evil.example/p.svg#x)"/></a>',
      '<image href="https://evil.example/track.png"/>',
      '</svg>',
    ].join('');
    const a = await uploadThemeAsset(ctxOf(), {
      kind: 'logo',
      filename: 'logo.svg',
      buf: Buffer.from(svg),
    });
    expect(a.mime).toBe('image/svg+xml');
    const stored = store.objects.get(`assets/${merchant.id}/${a.id}.svg`)!;
    const out = stored.body.toString('utf8');
    expect(stored.contentType).toBe('image/svg+xml');
    expect(out.startsWith('<svg')).toBe(true);
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('<use href="#g"');
    for (const bad of ['script', 'alert', 'onload', 'onclick', 'evil.example', 'javascript:']) {
      expect(out, bad).not.toContain(bad);
    }
    // The stored bytes are what the checksum and size describe.
    expect(a.size_bytes).toBe(stored.body.length);
    expect(a.checksum).toBe(createHash('sha256').update(stored.body).digest('hex'));

    const fo = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>',
    );
    const err = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'fo.svg', buf: fo }),
    );
    expect(err.code).toBe('ASSET_INVALID');
    expect(err.message).toMatch(/foreignObject/);
    const big = Buffer.from(`<svg>${' '.repeat(512 * 1024)}</svg>`);
    expect(
      (await rejection(uploadThemeAsset(ctxOf(), { kind: 'logo', filename: 'b.svg', buf: big })))
        .message,
    ).toMatch(/512 KB/);
  });

  it('201st asset is rejected', async () => {
    await prisma.themeAsset.createMany({
      data: Array.from({ length: THEME_ASSET_MAX_PER_MERCHANT }, (_, i) => ({
        id: `tasset_seed${String(i).padStart(3, '0')}`,
        merchantId: merchant.id,
        kind: 'image' as const,
        key: `assets/${merchant.id}/seed${i}.png`,
        url: `${env().TENDR_ASSET_ORIGIN}/assets/${merchant.id}/seed${i}.png`,
        mime: 'image/png',
        sizeBytes: 10,
        checksum: 'x',
      })),
    });
    const err = await rejection(
      uploadThemeAsset(ctxOf(), { kind: 'image', filename: 'a.png', buf: await pngOf(4, 4) }),
    );
    expect(err.code).toBe('ASSET_INVALID');
    expect(err.message).toMatch(/200/);
    expect(store.objects.size).toBe(0);
    // Another store still has room.
    const other = await createMerchant();
    await uploadThemeAsset(
      { merchantId: other.id, db: scopedDb({ merchantId: other.id, livemode: false }), store },
      { kind: 'image', filename: 'a.png', buf: await pngOf(4, 4) },
    );
  });

  it('asset used by a published theme cannot be deleted', async () => {
    const ctx = ctxOf();
    const logo = await uploadThemeAsset(ctx, {
      kind: 'logo',
      filename: 'l.png',
      buf: await pngOf(8, 8),
    });
    const t = await createTheme(ctx, { name: 'Main', from: 'blank' });
    await updateThemeDraft(ctx, t.id, {
      draft: { ...t.draft, settings: { ...t.draft.settings, logo_asset_id: logo.id } },
    });
    await publishTheme(ctx, t.id);
    // The draft drops the logo again; the published version still shows it.
    await updateThemeDraft(ctx, t.id, { draft: t.draft });

    const err = await rejection(deleteThemeAsset(ctx, logo.id));
    expect(err.code).toBe('ASSET_IN_USE');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ themes: [t.id] });
    expect(store.objects.size).toBe(1);

    // Unused: deleted from the store and the table.
    const spare = await uploadThemeAsset(ctx, {
      kind: 'image',
      filename: 's.png',
      buf: await pngOf(4, 4),
    });
    expect(await deleteThemeAsset(ctx, spare.id)).toEqual({
      id: spare.id,
      object: 'theme_asset',
      deleted: true,
    });
    expect(store.objects.has(`assets/${merchant.id}/${spare.id}.png`)).toBe(false);
    expect(await prisma.themeAsset.findUnique({ where: { id: spare.id } })).toBeNull();
    expect((await rejection(deleteThemeAsset(ctx, spare.id))).code).toBe('NOT_FOUND');
  });
});
