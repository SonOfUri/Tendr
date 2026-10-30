import type { LookupAddress } from 'node:dns';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  safeFetch,
  SafeFetchError,
  setSafeFetchResolver,
  setSafeFetchTransport,
  type SafeFetchReason,
} from './safe-fetch.js';

const PUBLIC_IP = '93.184.216.34';
/** Host → DNS answers. Unknown hosts do not resolve. */
const dns = new Map<string, string[]>([
  ['shop.example', [PUBLIC_IP]],
  ['cdn.example', ['93.184.216.35']],
  ['internal.example', ['10.0.0.1']],
]);

let server: Server;
let port = 0;
let requests: string[] = [];
const routes = new Map<string, (res: ServerResponse) => void>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const host = String(req.headers.host).replace(/:\d+$/, '');
    requests.push(`${host}${req.url}`);
    const route = routes.get(`${host}${req.url}`);
    if (route) return route(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  setSafeFetchResolver(null);
  setSafeFetchTransport(null);
  routes.clear();
  requests = [];
});

/**
 * Tests never touch the network: names resolve through `dns`, and the connection made with the
 * guarded lookup's (checked) answer is redirected to the local plain-http server.
 */
function useLocalServer(answers: Map<string, string[]> = dns): void {
  setSafeFetchResolver(async (host): Promise<LookupAddress[]> => {
    const ips = answers.get(host);
    if (!ips) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
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
async function reason(p: Promise<unknown>): Promise<SafeFetchReason> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SafeFetchError) return err.reason;
    throw err;
  }
  throw new Error('expected a SafeFetchError');
}

const opts = { timeoutMs: 2_000, maxBytes: 1024, maxRedirects: 3 };

describe('safeFetch', () => {
  it('fetches a public https url', async () => {
    useLocalServer();
    routes.set('shop.example/logo.png', (res) =>
      res.writeHead(200, { 'content-type': 'image/png' }).end('png-bytes'),
    );
    const r = await safeFetch('https://shop.example/logo.png', { ...opts, accept: 'image/*' });
    expect(r).toEqual({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('png-bytes'),
      finalUrl: 'https://shop.example/logo.png',
    });
  });

  it('refuses http', async () => {
    useLocalServer();
    expect(await reason(safeFetch('http://shop.example/logo.png', opts))).toBe('not_https');
    expect(await reason(safeFetch('ftp://shop.example/logo.png', opts))).toBe('not_https');
    expect(await reason(safeFetch('not a url', opts))).toBe('not_https');
    expect(requests).toEqual([]);
  });

  it('refuses private and metadata ips', async () => {
    useLocalServer();
    for (const url of [
      'https://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://internal.example/x',
    ]) {
      expect(await reason(safeFetch(url, opts)), url).toBe('private_address');
    }
    // A name that answered publicly at the check but privately at connect time (rebinding) is
    // refused by the connection's own lookup.
    let calls = 0;
    setSafeFetchResolver(async () => [
      { address: calls++ === 0 ? PUBLIC_IP : '127.0.0.1', family: 4 },
    ]);
    expect(await reason(safeFetch('https://flip.example/x', opts))).toBe('private_address');
    expect(requests).toEqual([]);
  });

  it('rechecks host on each redirect', async () => {
    useLocalServer();
    routes.set('shop.example/a', (res) =>
      res.writeHead(302, { location: 'https://cdn.example/b' }).end(),
    );
    routes.set('cdn.example/b', (res) => res.writeHead(301, { location: '/c' }).end());
    routes.set('cdn.example/c', (res) =>
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'),
    );
    const r = await safeFetch('https://shop.example/a', opts);
    expect(r.body.toString()).toBe('ok');
    expect(r.finalUrl).toBe('https://cdn.example/c');

    routes.set('shop.example/to-private', (res) =>
      res.writeHead(302, { location: 'https://internal.example/admin' }).end(),
    );
    routes.set('shop.example/to-metadata', (res) =>
      res.writeHead(307, { location: 'https://169.254.169.254/latest/meta-data/' }).end(),
    );
    routes.set('shop.example/to-http', (res) =>
      res.writeHead(302, { location: 'http://cdn.example/c' }).end(),
    );
    requests = [];
    expect(await reason(safeFetch('https://shop.example/to-private', opts))).toBe(
      'private_address',
    );
    expect(await reason(safeFetch('https://shop.example/to-metadata', opts))).toBe(
      'private_address',
    );
    expect(await reason(safeFetch('https://shop.example/to-http', opts))).toBe('not_https');
    // The private hop was never requested.
    expect(requests).toEqual([
      'shop.example/to-private',
      'shop.example/to-metadata',
      'shop.example/to-http',
    ]);

    routes.set('shop.example/loop', (res) => res.writeHead(302, { location: '/loop' }).end());
    expect(await reason(safeFetch('https://shop.example/loop', opts))).toBe('too_many_redirects');
    expect(await reason(safeFetch('https://shop.example/a', { ...opts, maxRedirects: 1 }))).toBe(
      'too_many_redirects',
    );
  });

  it('caps body size', async () => {
    useLocalServer();
    routes.set('shop.example/declared', (res) =>
      res.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000)),
    );
    routes.set('shop.example/streamed', (res) => {
      res.writeHead(200); // chunked: no content-length to trust
      for (let i = 0; i < 10; i++) res.write('y'.repeat(200));
      res.end();
    });
    routes.set('shop.example/exact', (res) => res.writeHead(200).end('z'.repeat(1024)));
    routes.set('shop.example/missing', (res) => res.writeHead(404).end());
    expect(await reason(safeFetch('https://shop.example/declared', opts))).toBe('too_large');
    expect(await reason(safeFetch('https://shop.example/streamed', opts))).toBe('too_large');
    expect((await safeFetch('https://shop.example/exact', opts)).body.length).toBe(1024);
    expect(await reason(safeFetch('https://shop.example/missing', opts))).toBe('bad_status');
  });

  it('times out', async () => {
    useLocalServer();
    routes.set('shop.example/slow', (res) => {
      res.writeHead(200);
      res.write('a');
      setTimeout(() => res.end('b'), 1_000);
    });
    routes.set('shop.example/hang', () => {}); // never answers
    const started = Date.now();
    expect(await reason(safeFetch('https://shop.example/slow', { ...opts, timeoutMs: 100 }))).toBe(
      'timeout',
    );
    expect(await reason(safeFetch('https://shop.example/hang', { ...opts, timeoutMs: 100 }))).toBe(
      'timeout',
    );
    expect(Date.now() - started).toBeLessThan(900);
  });
});
