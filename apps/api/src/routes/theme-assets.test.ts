import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { env } from '../env.js';
import { computeSignature } from '../gateway/signing.js';
import { prisma } from '../lib/prisma.js';
import { memoryObjectStore } from '../storage/object-store.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

const BOUNDARY = '----tendrtest';

/** A multipart/form-data body with `kind` and `file` fields. */
function form(kind: string, filename: string, file: Buffer, mime = 'application/octet-stream') {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
}

describe('theme asset routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let testKey: string;
  let store: ReturnType<typeof memoryObjectStore>;
  let png: Buffer;

  beforeEach(async () => {
    await resetDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = memoryObjectStore();
    app = await buildApp({ objectStore: store });
    await app.ready();
    merchant = await createMerchant({ name: 'Ada Fashion House' });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } })
      .png()
      .toBuffer();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  it('multipart upload returns asset object with asset-origin url', async () => {
    const f = form('logo', 'logo.png', png, 'image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/theme-assets',
      headers: { ...bearer(testKey), ...f.headers },
      payload: f.payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    const asset = res.json();
    expect(asset).toMatchObject({ object: 'theme_asset', kind: 'logo', mime: 'image/png' });
    expect(asset.url).toBe(`${env().TENDR_ASSET_ORIGIN}/assets/${merchant.id}/${asset.id}.png`);
    expect(store.objects.get(`assets/${merchant.id}/${asset.id}.png`)?.body).toEqual(png);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/theme-assets',
      headers: bearer(testKey),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ data: [asset] });

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/theme-assets/${asset.id}`,
      headers: bearer(testKey),
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json()).toEqual({ id: asset.id, object: 'theme_asset', deleted: true });
  });

  it('refuses bad kinds, missing files, oversized files and missing scopes', async () => {
    const post = (payload: Buffer, headers: Record<string, string>, key = testKey) =>
      app.inject({
        method: 'POST',
        url: '/v1/theme-assets',
        headers: { ...bearer(key), ...headers },
        payload,
      });

    const badKind = form('banner', 'logo.png', png);
    const r1 = await post(badKind.payload, badKind.headers);
    expect(r1.statusCode, r1.body).toBe(400);
    expect(r1.json().error.code).toBe('VALIDATION_ERROR');

    const noFile = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nlogo\r\n--${BOUNDARY}--\r\n`,
    );
    const r2 = await post(noFile, form('logo', 'x', png).headers);
    expect(r2.statusCode, r2.body).toBe(400);

    const big = form('image', 'big.png', Buffer.alloc(2 * 1024 * 1024 + 1));
    const r3 = await post(big.payload, big.headers);
    expect(r3.statusCode, r3.body).toBe(400);
    expect(r3.json().error.code).toBe('ASSET_INVALID');
    expect(store.objects.size).toBe(0);

    const readOnly = (await createApiKey(merchant.id, { livemode: false, scopes: ['themes:read'] }))
      .raw;
    const ok = form('logo', 'logo.png', png);
    expect((await post(ok.payload, ok.headers, readOnly)).statusCode).toBe(403);
  });

  it('dashboard viewers read, admins write', async () => {
    const viewerUser = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: viewerUser.id, role: 'viewer' });
    const viewer = dashHeaders(await loginAs(viewerUser.id), {
      merchantId: merchant.id,
      livemode: false,
    });
    const adminUser = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: adminUser.id, role: 'admin' });
    const admin = dashHeaders(await loginAs(adminUser.id), {
      merchantId: merchant.id,
      livemode: false,
    });

    const f = form('image', 'a.png', png);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/theme-assets',
      headers: { ...viewer, ...f.headers },
      payload: f.payload,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    const made = await app.inject({
      method: 'POST',
      url: '/v1/theme-assets',
      headers: { ...admin, ...f.headers },
      payload: f.payload,
    });
    expect(made.statusCode, made.body).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/v1/theme-assets', headers: viewer });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(1);
  });

  it('signing covers the multipart bytes', async () => {
    const secret = 'whsec_theme_assets_signing_secret';
    const key = (
      await createApiKey(merchant.id, {
        livemode: false,
        signingRequired: true,
        signingSecret: secret,
      })
    ).raw;
    const f = form('logo', 'logo.png', png, 'image/png');
    const t = Math.floor(Date.now() / 1000);
    const upload = (signedBody: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/v1/theme-assets',
        headers: {
          ...bearer(key),
          ...f.headers,
          'tendr-signature': `t=${t},v1=${computeSignature(secret, t, signedBody)}`,
        },
        payload: f.payload,
      });
    const empty = await upload(Buffer.alloc(0));
    expect(empty.statusCode, empty.body).toBe(401);
    expect(store.objects.size).toBe(0);
    const real = await upload(f.payload);
    expect(real.statusCode, real.body).toBe(201);
    expect(store.objects.size).toBe(1);
  });

  it('Idempotency-Key binds the uploaded file', async () => {
    const other = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#abcdef' },
    })
      .png()
      .toBuffer();
    const upload = (file: Buffer) => {
      const f = form('image', 'a.png', file);
      return app.inject({
        method: 'POST',
        url: '/v1/theme-assets',
        headers: { ...bearer(testKey), ...f.headers, 'idempotency-key': 'upload-1' },
        payload: f.payload,
      });
    };
    const first = await upload(png);
    expect(first.statusCode, first.body).toBe(201);
    const replay = await upload(png);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().id).toBe(first.json().id);
    const conflict = await upload(other);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(store.objects.size).toBe(1);
  });
});
