// The end-to-end tests' fixture store, on its own origin (http://localhost:3200; the same server
// as http://127.0.0.1:3200 is a second, unregistered origin). It serves:
//
// - `/` merchant-site.html, which loads tendr.js from the web server and opens the modal or mounts
//   the widget for `?session=<session url>&mode=modal|widget`;
// - `/thanks`, `/cancel`: the store pages the checkout returns to;
// - `POST /webhooks/:key`: the store's webhook endpoint. It verifies `Tendr-Signature` with the
//   key's shared secret (HMAC-SHA256 over `t + "." + raw body`, timing-safe, 5 min tolerance) and
//   keeps verified events; anything else is answered 400 and counted as rejected;
// - test controls: `POST /__secret/:key` sets a key's secret, `GET /__webhooks/:key` lists what
//   arrived.
//
// No dependencies; state is in memory for the life of the test run.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FIXTURE_PORT ?? 3200);
const TENDR_JS_URL = process.env.TENDR_JS_URL ?? 'http://localhost:3100/v1/tendr.js';
const TOLERANCE_S = 300;
const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, 'merchant-site.html'), 'utf8').replace(
  '__TENDR_JS_URL__',
  TENDR_JS_URL.replace(/[^A-Za-z0-9:/._-]/g, ''),
);

/** key → { secret, events: [verified payloads], rejected: n } */
const stores = new Map();
const storeOf = (key) => {
  if (!stores.has(key)) stores.set(key, { secret: null, events: [], rejected: 0 });
  return stores.get(key);
};

/** Whether `header` is a valid `t=..,v1=..` signature of `raw` (a Buffer) with `secret`. */
export function verifySignature(header, raw, secret, nowS = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(Buffer.from(v, 'hex'));
  }
  if (t === null || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

function body(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function send(res, status, type, text) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));
const html = (res, title) =>
  send(
    res,
    200,
    'text/html; charset=utf-8',
    `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`,
  );

const handler = async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const key = (prefix) =>
      url.pathname.startsWith(prefix)
        ? decodeURIComponent(url.pathname.slice(prefix.length))
        : null;

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', page);
    }
    if (req.method === 'GET' && url.pathname === '/thanks')
      return html(res, 'Thanks for your order');
    if (req.method === 'GET' && url.pathname === '/cancel') return html(res, 'Order not paid');

    const hook = key('/webhooks/');
    if (req.method === 'POST' && hook) {
      const raw = await body(req);
      const store = storeOf(hook);
      if (!verifySignature(req.headers['tendr-signature'], raw, store.secret)) {
        store.rejected += 1;
        return json(res, 400, { error: 'bad signature' });
      }
      store.events.push(JSON.parse(raw.toString('utf8')));
      return json(res, 200, { received: true });
    }

    const secretKey = key('/__secret/');
    if (req.method === 'POST' && secretKey) {
      const { secret } = JSON.parse((await body(req)).toString('utf8'));
      storeOf(secretKey).secret = String(secret);
      return json(res, 200, { ok: true });
    }

    const listKey = key('/__webhooks/');
    if (req.method === 'GET' && listKey) {
      const { events, rejected } = storeOf(listKey);
      return json(res, 200, { events, rejected });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
};

// Both loopbacks, each bound explicitly: `localhost` may resolve to either, and `127.0.0.1` is the
// unregistered origin. A port already taken on either one (another local server) fails loudly
// instead of the tests silently talking to someone else's app. Set E2E_STORE_PORT to move it.
for (const host of ['127.0.0.1', '::1']) {
  createServer(handler)
    .on('error', (err) => {
      if (host === '::1' && err.code === 'EADDRNOTAVAIL') return; // no IPv6 loopback here
      console.error(`fixture store: cannot listen on [${host}]:${PORT}: ${err.code ?? err}`);
      process.exit(1);
    })
    .listen(PORT, host, () => console.log(`fixture store on [${host}]:${PORT}`));
}
