import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { loadConfig } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { Engine } from '../server/engine.mjs';
import { simulatedProviders } from '../server/simulator.mjs';
import { createApp, errorHandler, sameOrigin } from '../server/http.mjs';
import { realProviders } from '../server/clients.mjs';

let directory, config, store, server, port, ca, cert, key;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tendr-shopify-mtls-'));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-subj',
    '/CN=localhost',
    '-days',
    '1',
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'client.key',
    '-out',
    'client.csr',
    '-subj',
    '/CN=ShopifyTestClient',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    'client.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'client.pem',
    '-days',
    '1',
  );
  ca = readFileSync(join(directory, 'ca.pem'));
  cert = readFileSync(join(directory, 'client.pem'));
  key = readFileSync(join(directory, 'client.key'));
  config = loadConfig({
    SHOPIFY_SIMULATOR: 'true',
    SHOPIFY_APP_URL: 'http://localhost:3355',
    SHOPIFY_STORAGE_KEY: randomBytes(32).toString('hex'),
  });
  store = new Store(':memory:', config.key);
  const providers = simulatedProviders(config, store);
  // Exercise the real TLS boundary with local CA fixtures, never an external provider.
  config.simulated = false;
  config.checkoutOrigin = config.origin;
  config.apiKey = 'fixture-client-id';
  config.apiSecret = 'fixture-app-secret';
  store.set('oauth', { shop: config.shop, accessToken: 'fixture-token' });
  const engine = new Engine(config, store, providers);
  const { app } = createApp(config, store, engine, providers);
  app.use(errorHandler);
  server = https.createServer(
    {
      cert: ca,
      key: readFileSync(join(directory, 'ca.key')),
      ca,
      requestCert: true,
      rejectUnauthorized: false,
    },
    app,
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}, 20_000);
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const body = {
  id: 'p1',
  gid: 'gid://shopify/PaymentSession/p1',
  test: true,
  amount: '1.00',
  currency: 'USD',
  kind: 'sale',
  payment_method: { type: 'offsite' },
};
async function request(
  path,
  { trusted = false, headers = {}, value = body, method = 'POST' } = {},
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        servername: 'localhost',
        port,
        path,
        method,
        ca,
        ...(trusted ? { cert, key } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Shopify-Shop-Domain': config.shop,
          'Shopify-Request-Id': 'request-1',
          'Shopify-Api-Version': config.apiVersion,
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      },
    );
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : JSON.stringify(value));
  });
}
describe('native mTLS boundary', () => {
  it('refuses absent certificates even with spoofed proxy/cert headers', async () => {
    expect(
      (
        await request('/payments/session', {
          headers: { 'X-Forwarded-Proto': 'https', 'X-SSL-Client-Verify': 'SUCCESS' },
        })
      ).status,
    ).toBe(401);
  });
  it('accepts a valid client certificate and matching store/version', async () => {
    expect((await request('/payments/session', { trusted: true })).status).toBe(201);
  });
  it('refuses a different store or unsupported API version', async () => {
    expect(
      (
        await request('/payments/session', {
          trusted: true,
          headers: { 'Shopify-Shop-Domain': 'another.myshopify.com' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/payments/session', {
          trusted: true,
          headers: { 'Shopify-Api-Version': '2024-01' },
        })
      ).status,
    ).toBe(400);
  });
  it('does not expose simulator mutations on real HTTP routes', async () => {
    expect((await request('/sim/pay')).status).toBe(404);
  });
  it('keeps OAuth restricted to the configured store', async () => {
    expect((await request('/auth?shop=attacker.myshopify.com', { method: 'GET' })).status).toBe(
      403,
    );
  });
  it('rejects forged uninstall events; verified uninstall disables credentials', async () => {
    const value = { myshopify_domain: config.shop };
    const headers = { 'X-Shopify-Shop-Domain': config.shop, 'X-Shopify-Topic': 'app/uninstalled' };
    expect((await request('/webhooks/shopify/uninstalled', { value, headers })).status).toBe(401);
    expect(store.get('oauth')).not.toBeNull();
    headers['X-Shopify-Hmac-Sha256'] = createHmac('sha256', config.apiSecret)
      .update(JSON.stringify(value))
      .digest('base64');
    expect((await request('/webhooks/shopify/uninstalled', { value, headers })).status).toBe(204);
    expect(store.get('oauth')).toBeNull();
    expect(store.get('ready')).toBe(false);
    expect((await request('/payments/session', { trusted: true })).status).toBe(403);
  });
});

describe('provider responses and configuration', () => {
  it.each([
    { errors: [{ message: 'Rate limited' }] },
    { data: { paymentSessionResolve: { userErrors: [{ message: 'Not allowed' }] } } },
    {
      data: {
        paymentSessionResolve: {
          userErrors: [],
          paymentSession: { id: body.gid, state: { code: 'PENDING' } },
        },
      },
    },
  ])('never treats an HTTP 200 GraphQL error or wrong state as success', async (response) => {
    const memory = new Store(':memory:', randomBytes(32));
    memory.set('oauth', { shop: config.shop, accessToken: 'fixture' });
    const client = realProviders(
      config,
      memory,
      vi.fn(async () => new Response(JSON.stringify(response))),
    );
    try {
      await expect(
        client.finish({ kind: 'payment', decision: 'resolve', input: body }),
      ).rejects.toThrow();
    } finally {
      memory.close();
    }
  });
  it('checks exact mutation confirmation and the pinned API path', async () => {
    const memory = new Store(':memory:', randomBytes(32));
    memory.set('oauth', { shop: config.shop, accessToken: 'fixture' });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              paymentSessionResolve: {
                userErrors: [],
                paymentSession: {
                  id: body.gid,
                  state: { code: 'RESOLVED' },
                  nextAction: { context: { redirectUrl: `https://${config.shop}/checkouts/1` } },
                },
              },
            },
          }),
        ),
    );
    try {
      const result = await realProviders(config, memory, fetcher).finish({
        kind: 'payment',
        decision: 'resolve',
        input: body,
      });
      expect(result.redirect).toContain(config.shop);
      expect(fetcher.mock.calls[0][0]).toBe(
        `https://${config.shop}/payments_apps/api/2026-10/graphql.json`,
      );
    } finally {
      memory.close();
    }
  });
  it('simulator rejects real keys, non-loopback origins and weak encryption keys', () => {
    const base = {
      SHOPIFY_SIMULATOR: 'true',
      SHOPIFY_APP_URL: 'http://localhost:3355',
      SHOPIFY_STORAGE_KEY: randomBytes(32).toString('hex'),
    };
    for (const extra of [
      { TENDR_LIVE_SECRET_KEY: 'tdr_live_fake' },
      { SHOPIFY_APP_URL: 'https://public.example' },
      { SHOPIFY_STORAGE_KEY: 'weak' },
    ])
      expect(() => loadConfig({ ...base, ...extra })).toThrow();
  });
  it('rejects browser mutations from another origin', () => {
    expect(() =>
      sameOrigin(
        new Request('http://localhost:3355/app', {
          headers: { Origin: 'https://attacker.example' },
        }),
        config,
      ),
    ).toThrow();
  });
});
