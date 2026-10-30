// Outbound fetches of URLs a merchant (or a cart) supplied: brand pulls, product images, store
// logos. Every one goes through `safeFetch`, never a bare `fetch`.
//
// The SSRF guard is shared with webhook delivery (checkout/webhooks.ts): an address is refused if
// it is private, loopback, link-local or otherwise not publicly routable (`isPrivateAddress`), a
// host is refused if any DNS answer is (`assertPublicHost`), and the socket's own DNS lookup
// refuses private answers too (`guardedLookup`), so the address connected to is the one checked —
// a rebinding answer cannot slip in between the check and the connect.
//
// `safeFetch` adds: https only; redirects followed by hand, each hop's URL and host checked again;
// one overall timeout; the body streamed with a byte cap.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// ─── addresses ──────────────────────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (deprecated; embeds any IPv4) — T9
  ['64:ff9b::', 96], // NAT64: may front any IPv4, including private ones
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo: tunnels to an arbitrary IPv4 — T9
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: embeds an arbitrary IPv4
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP literal is private, loopback, link-local or otherwise not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // not an IP: never treated as safe
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1): judge the embedded IPv4. IPv4-compatible
  // (::a.b.c.d) is in ::/96 and blocked outright.
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1]!;
    if (isIP(tail) === 4) return blocked.check(tail, 'ipv4');
    const parts = tail.split(':');
    if (parts.length === 2) {
      const n = (parseInt(parts[0]!, 16) << 16) | parseInt(parts[1]!, 16);
      const v4 = [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
      return blocked.check(v4, 'ipv4');
    }
    return true;
  }
  return blocked.check(ip, 'ipv6');
}

// ─── DNS ────────────────────────────────────────────────────────────────────

type Resolver = (host: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs),
    ),
  );
let resolver: Resolver = systemResolver;

/** Test hook: replaces the DNS resolver (null restores the system one). Tests never use the network. */
export function setSafeFetchResolver(fn: Resolver | null): void {
  resolver = fn ?? systemResolver;
}

/** The errors `assertPublicHost` throws; callers with their own error shape pass their own. */
export type HostErrors = { blocked: () => Error; unresolved: () => Error };

const defaultHostErrors: HostErrors = {
  blocked: () => new SafeFetchError('private_address', 'The host is a private address'),
  unresolved: () => new SafeFetchError('network_error', 'The host could not be resolved'),
};

/** Throws unless `hostname` is a public IP literal or resolves only to public addresses. */
export async function assertPublicHost(
  hostname: string,
  errors: HostErrors = defaultHostErrors,
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw errors.blocked();
    return;
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(host);
  } catch {
    throw errors.unresolved();
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw errors.blocked();
  }
}

/** The error code a guarded lookup fails with when the host resolves to a private address. */
export const BLOCKED_LOOKUP_CODE = 'EBLOCKED';

/**
 * A `lookup` for an outbound socket that refuses private answers, so the address actually
 * connected to is the one checked (no DNS-rebinding gap between check and connect).
 */
export function guardedLookup(
  blockedMessage = 'host resolves to a private address',
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (addrs) => {
        const family = typeof options === 'object' ? options.family : undefined;
        const usable = addrs.filter((a) => !family || a.family === family);
        if (usable.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
          const err = Object.assign(new Error(blockedMessage), { code: BLOCKED_LOOKUP_CODE });
          return callback(err, '', 4);
        }
        if (typeof options === 'object' && options.all) {
          return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
        }
        callback(null, usable[0]!.address, usable[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    );
  };
}

// ─── safeFetch ──────────────────────────────────────────────────────────────

export type SafeFetchReason =
  | 'not_https'
  | 'private_address'
  | 'too_large'
  | 'timeout'
  | 'too_many_redirects'
  | 'bad_status'
  /** Unresolvable host, refused connection, TLS failure, reset: the fetch never completed. */
  | 'network_error';

export class SafeFetchError extends Error {
  constructor(
    readonly reason: SafeFetchReason,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export type SafeFetchOptions = {
  /** Overall budget for every hop, headers and body included. */
  timeoutMs: number;
  /** Largest body accepted, in bytes. */
  maxBytes: number;
  /** Redirects followed before giving up (0 = none). */
  maxRedirects: number;
  accept?: string;
};

export type SafeFetchResult = {
  status: number;
  contentType: string;
  body: Buffer;
  /** The URL the body came from, after redirects. */
  finalUrl: string;
};

/** Opens one request. The default is `https.request`; tests swap in a local server. */
export type SafeFetchTransport = (url: URL, options: RequestOptions) => ClientRequest;

const httpsTransport: SafeFetchTransport = (url, options) => httpsRequest(url, options);
let transport: SafeFetchTransport = httpsTransport;

/**
 * Test hook: replaces the transport (null restores https). The URL checks, the host checks and
 * the guarded `lookup` passed in `options` still apply.
 */
export function setSafeFetchTransport(fn: SafeFetchTransport | null): void {
  transport = fn ?? httpsTransport;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const lookup = guardedLookup();

function httpsUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new SafeFetchError('not_https', 'The URL is not valid');
  }
  if (url.protocol !== 'https:')
    throw new SafeFetchError('not_https', 'Only https:// URLs are fetched');
  url.hash = '';
  return url;
}

/**
 * GETs an https URL whose host must be public, following at most `maxRedirects` redirects (each
 * hop checked again), within `timeoutMs` overall, refusing bodies over `maxBytes`. Resolves only
 * with a 2xx; everything else throws `SafeFetchError`.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let url = httpsUrl(raw);
  for (let hop = 0; ; hop++) {
    await withDeadline(assertPublicHost(url.hostname), deadline);
    const res = await fetchOnce(url, opts, deadline);
    if ('redirect' in res) {
      if (hop >= opts.maxRedirects) {
        throw new SafeFetchError('too_many_redirects', `More than ${opts.maxRedirects} redirects`);
      }
      url = httpsUrl(res.redirect, url);
      continue;
    }
    return { ...res, finalUrl: url.toString() };
  }
}

const timeoutError = () => new SafeFetchError('timeout', 'The fetch timed out');

async function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Hop = { redirect: string } | Omit<SafeFetchResult, 'finalUrl'>;

function fetchOnce(url: URL, opts: SafeFetchOptions, deadline: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, value?: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const headers: Record<string, string> = { 'user-agent': 'Tendr/1.0' };
    if (opts.accept) headers.accept = opts.accept;
    const req = transport(url, { method: 'GET', headers, lookup });
    const timer = setTimeout(() => done(timeoutError()), Math.max(0, deadline - Date.now()));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === BLOCKED_LOOKUP_CODE) {
        return done(new SafeFetchError('private_address', 'The host is a private address'));
      }
      done(new SafeFetchError('network_error', `The fetch failed: ${err.message}`));
    });
    req.on('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location) {
          return done(
            new SafeFetchError('bad_status', `Redirect ${status} without a location`, status),
          );
        }
        return done(null, { redirect: location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return done(new SafeFetchError('bad_status', `The server answered ${status}`, status));
      }
      const tooLarge = () =>
        new SafeFetchError('too_large', `The response is larger than ${opts.maxBytes} bytes`);
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) return done(tooLarge());
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > opts.maxBytes) return done(tooLarge());
        chunks.push(chunk);
      });
      res.on('end', () =>
        done(null, {
          status,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }),
      );
      res.on('error', (err) =>
        done(new SafeFetchError('network_error', `The fetch failed: ${err.message}`)),
      );
    });
    req.end();
  });
}
