// The web server's internal credential (payment links, spec §5).
//
// The payer's link page is rendered by the web server, so its reads of the API all come from the
// server's address. It sends `x-tendr-internal: <WEB_INTERNAL_TOKEN>` and the payer's IP in
// `x-tendr-client-ip`; the API believes that IP only alongside the right token, and then keys
// per-IP limits on it instead of on the server. Only `GET` under `/v1/payment_links/public/` (the
// link read the web server makes) honours them: on every other route the headers are ignored and
// the caller is `req.ip`. The token is compared in constant time and never logged.
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { log } from '../lib/logger.js';

export const INTERNAL_TOKEN_HEADER = 'x-tendr-internal';
export const CLIENT_IP_HEADER = 'x-tendr-client-ip';

/** The public payment-link routes (routes/payment-links-public.ts). */
export const PAYMENT_LINK_PUBLIC_PREFIX = '/v1/payment_links/public/';

/** The only requests the web server's token is honoured on: reads of the public link routes. */
function internalRoute(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url;
  return (
    req.method === 'GET' && typeof url === 'string' && url.startsWith(PAYMENT_LINK_PUBLIC_PREFIX)
  );
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function tokenMatches(given: string | undefined): boolean {
  const expected = env().WEB_INTERNAL_TOKEN;
  if (!expected || given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `trusted`: a public link read carrying the web server's token. `clientIp`: the address per-IP
 * limits key on — the payer's IP from `x-tendr-client-ip` for a trusted request with a valid
 * IPv4/IPv6 literal there, otherwise `req.ip`. Any other route is never trusted.
 */
export function internalClient(req: FastifyRequest): InternalClient {
  // Several hooks ask per request; decide (and warn) once.
  const known = decided.get(req);
  if (known) return known;
  const out = decide(req);
  decided.set(req, out);
  return out;
}

export type InternalClient = { trusted: boolean; clientIp: string };

const decided = new WeakMap<FastifyRequest, InternalClient>();

function decide(req: FastifyRequest): InternalClient {
  if (!internalRoute(req)) return { trusted: false, clientIp: req.ip };
  const trusted = tokenMatches(header(req, INTERNAL_TOKEN_HEADER));
  const forwarded = header(req, CLIENT_IP_HEADER)?.trim();
  const valid = forwarded !== undefined && isIP(forwarded) !== 0;
  if (trusted && !valid) {
    // The web server should always forward the payer's address; without it every payer shares
    // the server's bucket. Neither the token nor the header value is logged.
    log('warn', 'internal request without a valid client ip', {
      requestId: req.id,
      clientIpHeader: forwarded === undefined || forwarded === '' ? 'missing' : 'invalid',
    });
  }
  return { trusted, clientIp: trusted && valid && forwarded ? forwarded : req.ip };
}
