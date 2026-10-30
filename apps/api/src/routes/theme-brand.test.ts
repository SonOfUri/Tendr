import type { LookupAddress } from 'node:dns';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { setSafeFetchResolver, setSafeFetchTransport } from '../lib/safe-fetch.js';
import { memoryObjectStore } from '../storage/object-store.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import { createApiKey, createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

// Tests never touch the network: names resolve through `dns`, and the guarded connection is sent
// to a local plain-http server that answers from `routes` (host + path).
const dns = new Map<string, string[]>([
  ['shop.example', ['93.184.216.34']],
  ['cdn.example', ['93.184.216.35']],
]);
const routes = new Map<string, (res: ServerResponse) => void>();
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = String(req.headers.host).replace(/:\d+$/, '');
    const route = routes.get(`${host}${req.url}`);
    if (route) return route(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
});

function useLocalServer(): void {
  setSafeFetchResolver(async (host): Promise<LookupAddress[]> => {
    const ips = dns.get(host);
    if (!ips) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return ips.map((address) => ({ address, family: 4 }));
  });
  setSafeFetchTransport((url, options) => {
    const guarded = options.lookup as LookupFunction;
    const toLocal: LookupFunction = (host, o, cb) =>
      guarded(host, o, (err, address) => {
        if (err) return cb(err, '', 4);
        if (Array.isArray(address)) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
        cb(null, '127.0.0.1', 4);
      });
    return httpRequest({
      ...options,
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      lookup: toLocal,
    });
  });
}

const serve = (path: string, type: string, body: Buffer | string) =>
  routes.set(path, (res) => res.writeHead(200, { 'content-type': type }).end(body));

describe('theme brand routes', () => {
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
    merchant = await createMerchant({ name: 'Acme Socks Ltd' });
    testKey = (await createApiKey(merchant.id, { livemode: false })).raw;
    png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0a7d5a' } })
      .png()
      .toBuffer();
    useLocalServer();
  });
  afterEach(async () => {
    await app.close();
    setSafeFetchResolver(null);
    setSafeFetchTransport(null);
    routes.clear();
    vi.restoreAllMocks();
  });

  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
  const post = (url: string, payload: object, headers: Record<string, string> = bearer(testKey)) =>
    app.inject({ method: 'POST', url, headers, payload });

  async function connectionKey() {
    const connection = await createRow('Connection', merchant.id, false, {});
    const key = await createApiKey(merchant.id, { livemode: false });
    await prisma.apiKey.update({
      where: { id: key.record.id },
      data: { connectionId: connection.id },
    });
    return { connectionId: connection.id, raw: key.raw };
  }

  it('from-website creates a draft and never publishes', async () => {
    serve(
      'shop.example/',
      'text/html; charset=utf-8',
      `<html><head><title>Acme Socks | Home</title>
        <meta name="theme-color" content="#0A7D5A">
        <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example/touch.png">
        <link rel="icon" href="/favicon.png"></head><body></body></html>`,
    );
    serve('cdn.example/touch.png', 'image/png', png);

    const res = await post('/v1/themes/from-website', { url: 'https://shop.example/' });
    expect(res.statusCode, res.body).toBe(201);
    const theme = res.json();
    expect(theme).toMatchObject({ object: 'theme', status: 'draft', published: null, version: 1 });
    expect(theme.published_at).toBeNull();
    expect(theme.draft.settings).toMatchObject({ display_name: 'Acme Socks', mode: 'dark' });
    expect(theme.draft.settings.palettes.dark.accent).toBe('#0a7d5a');

    const asset = await prisma.themeAsset.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(theme.draft.settings.logo_asset_id).toBe(asset.id);
    expect(asset).toMatchObject({ kind: 'logo', mime: 'image/png' });
    expect(store.objects.get(asset.key)?.body).toEqual(png);

    const row = await prisma.checkoutTheme.findFirstOrThrow({ where: { id: theme.id } });
    expect(row.published).toBeNull();
    expect(row.isDefault).toBe(false);
  });

  it('a site with no logo or colour still gets a draft', async () => {
    serve('shop.example/', 'text/html', '<html><head></head></html>');
    const res = await post('/v1/themes/from-website', {
      url: 'https://shop.example/',
      name: 'From my site',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ name: 'From my site', status: 'draft' });
    expect(res.json().draft.settings.display_name).toBe('Acme Socks Ltd');
    expect(res.json().draft.settings.logo_asset_id).toBeUndefined();
  });

  it('unreachable website is BRAND_FETCH_FAILED', async () => {
    const res = await post('/v1/themes/from-website', { url: 'https://nowhere.example/' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'BRAND_FETCH_FAILED',
      details: { reason: 'network_error' },
    });
    const notFound = await post('/v1/themes/from-website', { url: 'https://shop.example/' });
    expect(notFound.statusCode, notFound.body).toBe(422);
    expect(notFound.json().error.details.reason).toBe('bad_status');
    expect(await prisma.checkoutTheme.count()).toBe(0);
  });

  it('11th pull in an hour is 429', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post('/v1/themes/from-website', { url: 'https://nowhere.example/' });
      expect(r.statusCode, r.body).toBe(422);
    }
    const blocked = await post('/v1/themes/from-website', { url: 'https://nowhere.example/' });
    expect(blocked.statusCode, blocked.body).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    // The limit is per merchant, whatever the key: another key of the store is limited too, and
    // from-store shares it.
    const other = (await createApiKey(merchant.id, { livemode: true })).raw;
    const viaStore = await post('/v1/themes/from-store', { connection_id: 'con_x' }, bearer(other));
    expect(viaStore.statusCode, viaStore.body).toBe(429);
    // Another store is not.
    const m2 = await createMerchant();
    const k2 = (await createApiKey(m2.id, { livemode: false })).raw;
    const fresh = await post(
      '/v1/themes/from-website',
      { url: 'https://nowhere.example/' },
      bearer(k2),
    );
    expect(fresh.statusCode, fresh.body).toBe(422);
  });

  it('connection key can PUT brand, dashboard user cannot', async () => {
    const { connectionId, raw } = await connectionKey();
    const brand = {
      site_name: 'Acme Store',
      logo_url: 'https://cdn.example/logo.png',
      palette: ['#ffffff', '#0a7d5a'],
    };
    const put = (headers: Record<string, string>, payload: object = brand) =>
      app.inject({ method: 'PUT', url: '/v1/connection/brand', headers, payload });

    const ok = await put(bearer(raw));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ connection_id: connectionId, brand });
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.brand).toEqual(brand);
    expect(row.brandUpdatedAt).toBeInstanceOf(Date);

    const bad = await put(bearer(raw), { palette: ['red'] });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');

    // A hand-made secret key and a dashboard admin are both refused.
    expect((await put(bearer(testKey))).statusCode).toBe(403);
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role: 'owner' });
    const login = await loginAs(user.id);
    const dash = await put(dashHeaders(login, { merchantId: merchant.id, livemode: false }));
    expect(dash.statusCode, dash.body).toBe(403);
    expect(dash.json().error.code).toBe('FORBIDDEN');
  });

  it('from-store uses stored brand', async () => {
    const { connectionId, raw } = await connectionKey();
    const none = await post('/v1/themes/from-store', { connection_id: connectionId });
    expect(none.statusCode, none.body).toBe(404);

    serve('cdn.example/logo.png', 'image/png', png);
    const brand = {
      site_name: 'Acme Store',
      logo_url: 'https://cdn.example/logo.png',
      palette: ['#ffffff', '#111111', '#0a7d5a', '#ff0000'],
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/connection/brand',
      headers: bearer(raw),
      payload: brand,
    });
    expect(put.statusCode, put.body).toBe(200);

    const res = await post('/v1/themes/from-store', { connection_id: connectionId });
    expect(res.statusCode, res.body).toBe(201);
    const theme = res.json();
    expect(theme).toMatchObject({ status: 'draft', published: null });
    expect(theme.draft.settings).toMatchObject({ display_name: 'Acme Store', mode: 'dark' });
    expect(theme.draft.settings.palettes.dark.accent).toBe('#0a7d5a');
    const asset = await prisma.themeAsset.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(theme.draft.settings.logo_asset_id).toBe(asset.id);

    // Another store's connection is not found.
    const m2 = await createMerchant();
    const k2 = (await createApiKey(m2.id, { livemode: false })).raw;
    const foreign = await post(
      '/v1/themes/from-store',
      { connection_id: connectionId },
      bearer(k2),
    );
    expect(foreign.statusCode, foreign.body).toBe(404);
  });
});
