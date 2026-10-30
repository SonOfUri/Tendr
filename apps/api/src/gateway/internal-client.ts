// The web server's internal credential (payment links, spec §5).
//
// The payer's link page is rendered by the web server, so its reads of the API all come from the
// server's address. It sends `x-tendr-internal: <WEB_INTERNAL_TOKEN>` and the payer's IP in
// `x-tendr-client-ip`; the API believes that IP only alongside the right token, and then keys
// per-IP limits on it instead of on the server. The token is compared in constant time and never
// logged.
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { env } from '../env.js';

export const INTERNAL_TOKEN_HEADER = 'x-tendr-internal';
export const CLIENT_IP_HEADER = 'x-tendr-client-ip';

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
 * `trusted`: the request carries the web server's token. `clientIp`: the address per-IP limits
 * key on — the payer's IP from `x-tendr-client-ip` for a trusted request with a valid IPv4/IPv6
 * literal there, otherwise `req.ip`.
 */
export function internalClient(req: FastifyRequest): { trusted: boolean; clientIp: string } {
  const trusted = tokenMatches(header(req, INTERNAL_TOKEN_HEADER));
  const forwarded = header(req, CLIENT_IP_HEADER)?.trim();
  const clientIp = trusted && forwarded && isIP(forwarded) !== 0 ? forwarded : req.ip;
  return { trusted, clientIp };
}
