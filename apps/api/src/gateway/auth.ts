// Authentication and authorization for `/v1` routes.
//
// Every `/v1/*` route must declare `config.auth`; a missing declaration fails startup.
// A `preHandler` resolves the Bearer credential to a principal, checks the route's allowed
// principal kinds and scope, and attaches a client scoped to the principal's merchant + mode
// as `req.db`.
//
// Credential lookups are infrastructure work and use the unscoped `prisma`.
import { ScopeValues, type Scope } from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { scopedDb } from '../db/scoped.js';
import { safeEqualHex, sha256 } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { Principal } from './principal.js';

/** Key prefixes; publishable ones first, since `tdr_pk_…` must not parse as a secret key. */
const KEY_PREFIXES = [
  { prefix: 'tdr_pk_test_', kind: 'publishable', livemode: false },
  { prefix: 'tdr_pk_live_', kind: 'publishable', livemode: true },
  { prefix: 'tdr_test_', kind: 'secret', livemode: false },
  { prefix: 'tdr_live_', kind: 'secret', livemode: true },
] as const;

/** `ses_<ULID>_secret_<32 hex>`; group 1 is the session id. */
const SESSION_SECRET = /^(ses_[0-9A-HJKMNP-TV-Z]{26})_secret_[0-9a-f]{32}$/;

const LAST_USED_INTERVAL_MS = 60_000;

const KNOWN_SCOPES = new Set<string>(ScopeValues);

function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  const match = header ? /^Bearer +(\S+)\s*$/.exec(header) : null;
  return match?.[1];
}

async function resolveApiKey(raw: string): Promise<Principal | null> {
  const expected = KEY_PREFIXES.find((p) => raw.startsWith(p.prefix));
  if (!expected) return null;
  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(raw) } });
  if (!key || key.revokedAt) return null;
  // The prefix states kind and mode; both must agree with the stored row.
  if (key.kind !== expected.kind || key.livemode !== expected.livemode) return null;

  touchLastUsed(key.id);
  const scopes = key.scopes.filter((s): s is Scope => KNOWN_SCOPES.has(s));
  const base = { merchantId: key.merchantId, livemode: key.livemode, apiKeyId: key.id, scopes };
  return { kind: key.kind === 'publishable' ? 'publishable_key' : 'secret_key', ...base };
}

/** Expired sessions still authenticate: the checkout screens must be able to show EXPIRED. */
async function resolveSessionSecret(raw: string): Promise<Principal | null> {
  const match = SESSION_SECRET.exec(raw);
  if (!match) return null;
  const session = await prisma.session.findUnique({
    where: { id: match[1] },
    select: { id: true, merchantId: true, livemode: true, clientSecretHash: true },
  });
  if (!session || !safeEqualHex(sha256(raw), session.clientSecretHash)) return null;
  return {
    kind: 'session_client',
    merchantId: session.merchantId,
    livemode: session.livemode,
    sessionId: session.id,
  };
}

/** Records key use at most once per minute. Fire-and-forget: never fails the request. */
function touchLastUsed(apiKeyId: string): void {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LAST_USED_INTERVAL_MS);
  prisma.apiKey
    .updateMany({
      where: {
        id: apiKeyId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: now },
    })
    .catch((err: unknown) => {
      log('error', 'failed to record api key use', { apiKeyId, err: String(err) });
    });
}

async function resolvePrincipal(raw: string): Promise<Principal | null> {
  return raw.startsWith('ses_') ? resolveSessionSecret(raw) : resolveApiKey(raw);
}

const authPlugin: FastifyPluginAsync = async (app) => {
  // Routes are collected as they are added and rejected in `onReady`, so `ready()` /
  // `listen()` fail; a throw in `onRoute` would surface wherever the route was added.
  const unconfigured: string[] = [];
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/v1/') && route.config?.auth === undefined) {
      unconfigured.push(`${String(route.method)} ${route.url}`);
    }
  });
  app.addHook('onReady', async () => {
    if (unconfigured.length > 0) {
      throw new Error(`routes without auth config: ${unconfigured.join(', ')}`);
    }
  });

  app.addHook('preHandler', async (req) => {
    const auth = req.routeOptions.config.auth;
    if (auth === undefined || auth === 'public') return;

    const raw = bearerToken(req);
    const principal = raw ? await resolvePrincipal(raw) : null;
    if (!principal) throw unauthorized('Invalid or missing credentials');

    if (!auth.principals.includes(principal.kind)) {
      throw forbidden(`This endpoint is not available to ${principal.kind} credentials`);
    }
    // API keys (secret and publishable) carry scopes; session clients are confined by the
    // kind allowlist alone.
    if (auth.scope && 'scopes' in principal && !principal.scopes.includes(auth.scope)) {
      throw forbidden(`Missing scope ${auth.scope}`);
    }

    req.principal = principal;
    req.db = scopedDb({ merchantId: principal.merchantId, livemode: principal.livemode });
  });

  app.addHook('onResponse', async (req, reply) => {
    const p = req.principal;
    if (!p) return;
    log('info', 'request', {
      requestId: req.id,
      method: req.method,
      route: req.routeOptions.url,
      statusCode: reply.statusCode,
      merchantId: p.merchantId,
      livemode: p.livemode,
      principal: p.kind,
    });
  });
};

export const auth = fp(authPlugin, { name: 'tendr-auth' });
