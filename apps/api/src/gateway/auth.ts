// Authentication and authorization for `/v1` routes.
//
// Every `/v1/*` route must declare `config.auth`; a missing declaration fails startup.
// An `onRequest` hook resolves the caller to a principal, checks the route's allowed principal
// kinds, scope (API keys) and permission (dashboard users), and attaches a client scoped to the
// principal's merchant + mode as `req.db`.
//
// Credentials:
// - `Authorization: Bearer …` — API keys and checkout session secrets. Always wins when present.
// - The `tendr_session` cookie — dashboard sessions, only on routes that allow `dashboard_user`
//   or `user_session`. With `Tendr-Merchant: mer_…` and `Tendr-Livemode: true|false` (and a route
//   allowing `dashboard_user`) the person's membership in that store becomes a `dashboard_user`
//   principal; no membership → 403. Without a store header, routes allowing `user_session` get
//   one (no merchant, no `req.db`). Cookie-authenticated mutations must send `Tendr-CSRF`
//   matching the session's CSRF value (double-submit cookie, bound to the session token).
//
// Credential lookups are infrastructure work and use the unscoped `prisma`. A credential of a
// merchant that is not `active` (suspended or closed) is treated exactly like an invalid one.
import {
  CSRF_HEADER,
  LIVEMODE_HEADER,
  MERCHANT_HEADER,
  ROLE_PERMISSIONS,
  ScopeValues,
  SESSION_COOKIE,
  type PrincipalKind,
  type Scope,
} from '@tendr/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { scopedDb } from '../db/scoped.js';
import { safeEqualHex, sha256 } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getSecret } from '../secrets/secrets.js';
import {
  csrfMatches,
  parseCookies,
  resolveDashboardSession,
  sessionCookies,
  type ResolvedSession,
} from '../auth/session.js';
import type { Principal, RouteAuth } from './principal.js';
import { verifyRequestSignature } from './signing.js';

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
  // Auth schemes are case-insensitive (RFC 7235).
  const match = header ? /^Bearer +(\S+)\s*$/i.exec(header) : null;
  return match?.[1];
}

/** Whether a route URL is under the authenticated `/v1` namespace (including `/v1` itself). */
export function isV1(url: string | undefined): boolean {
  return url === '/v1' || (url?.startsWith('/v1/') ?? false);
}

/**
 * The auth config to apply to a matched route. Fails closed: a `/v1` route without config
 * is refused with 500 even though startup already rejects such routes.
 */
export function routeAuth(url: string | undefined, auth: RouteAuth | undefined): RouteAuth | null {
  if (auth !== undefined) return auth;
  if (isV1(url)) throw new AppError('INTERNAL_ERROR', 'route missing auth config', 500);
  return null;
}

/** Signing settings of the authenticated secret key; kept off the public Principal. */
type SigningConfig = { signingSecretRef: string | null; signingRequired: boolean };
const signingConfigs = new WeakMap<FastifyRequest, SigningConfig>();

type Resolved = {
  principal: Principal;
  signing?: SigningConfig;
  /** Set when the principal came from the dashboard session cookie. */
  cookie?: { token: string; session: ResolvedSession };
};

async function resolveApiKey(raw: string): Promise<Resolved | null> {
  const expected = KEY_PREFIXES.find((p) => raw.startsWith(p.prefix));
  if (!expected) return null;
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: sha256(raw) },
    include: { merchant: { select: { status: true } } },
  });
  if (!key || key.revokedAt || key.merchant.status !== 'active') return null;
  // The prefix states kind and mode; both must agree with the stored row.
  if (key.kind !== expected.kind || key.livemode !== expected.livemode) return null;

  touchLastUsed(key.id);
  const scopes = key.scopes.filter((s): s is Scope => KNOWN_SCOPES.has(s));
  const base = { merchantId: key.merchantId, livemode: key.livemode, apiKeyId: key.id, scopes };
  return {
    principal: { kind: key.kind === 'publishable' ? 'publishable_key' : 'secret_key', ...base },
    signing: { signingSecretRef: key.signingSecretRef, signingRequired: key.signingRequired },
  };
}

/** Expired sessions still authenticate: the checkout screens must be able to show EXPIRED. */
async function resolveSessionSecret(raw: string): Promise<Resolved | null> {
  const match = SESSION_SECRET.exec(raw);
  if (!match) return null;
  const session = await prisma.session.findUnique({
    where: { id: match[1] },
    select: {
      id: true,
      merchantId: true,
      livemode: true,
      clientSecretHash: true,
      merchant: { select: { status: true } },
    },
  });
  if (!session || !safeEqualHex(sha256(raw), session.clientSecretHash)) return null;
  if (session.merchant.status !== 'active') return null;
  return {
    principal: {
      kind: 'session_client',
      merchantId: session.merchantId,
      livemode: session.livemode,
      sessionId: session.id,
    },
  };
}

const signatureInvalid = (message = 'Request signature invalid') =>
  new AppError('SIGNATURE_INVALID', message, 401);

const pendingTouches = new Set<Promise<void>>();

/** Records key use at most once per minute. Fire-and-forget: never fails the request. */
function touchLastUsed(apiKeyId: string): void {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LAST_USED_INTERVAL_MS);
  const touch = prisma.apiKey
    .updateMany({
      where: {
        id: apiKeyId,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: now },
    })
    .then(
      () => undefined,
      (err: unknown) => {
        log('error', 'failed to record api key use', { apiKeyId, err: String(err) });
      },
    )
    .finally(() => pendingTouches.delete(touch));
  pendingTouches.add(touch);
}

/** Waits for in-flight `last_used_at` writes (tests, shutdown). */
export async function flushLastUsed(): Promise<void> {
  await Promise.all([...pendingTouches]);
}

async function resolvePrincipal(raw: string): Promise<Resolved | null> {
  return raw.startsWith('ses_') ? resolveSessionSecret(raw) : resolveApiKey(raw);
}

const COOKIE_KINDS: ReadonlySet<PrincipalKind> = new Set(['dashboard_user', 'user_session']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MERCHANT_ID = /^mer_[0-9A-HJKMNP-TV-Z]{26}$/;

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const badHeader = (message: string) => new AppError('VALIDATION_ERROR', message, 400);

/**
 * Resolves the dashboard session cookie. With a store header on a route allowing
 * `dashboard_user`, the person's membership in that store; otherwise a `user_session` (when the
 * route allows it). Returns null when there is no live session.
 */
async function resolveCookie(
  req: FastifyRequest,
  allowed: PrincipalKind[],
): Promise<Resolved | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = await resolveDashboardSession(token);
  if (!session) return null;
  const cookie = { token, session };

  const merchantId = header(req, MERCHANT_HEADER);
  const allowsStore = allowed.includes('dashboard_user');
  const allowsPerson = allowed.includes('user_session');
  if (!allowsStore || (merchantId === undefined && allowsPerson)) {
    return {
      principal: { kind: 'user_session', userId: session.userId, sessionId: session.sessionId },
      cookie,
    };
  }
  if (merchantId === undefined || !MERCHANT_ID.test(merchantId)) {
    throw badHeader('Tendr-Merchant header (mer_…) is required');
  }
  const mode = header(req, LIVEMODE_HEADER);
  if (mode !== 'true' && mode !== 'false') {
    throw badHeader('Tendr-Livemode header must be true or false');
  }
  const membership = await prisma.merchantUser.findUnique({
    where: { merchantId_userId: { merchantId, userId: session.userId } },
    include: { merchant: { select: { status: true } } },
  });
  // A store the person is not in, or one that is not active, looks the same.
  if (!membership || membership.merchant.status !== 'active') {
    throw forbidden('You are not a member of this store');
  }
  return {
    principal: {
      kind: 'dashboard_user',
      merchantId,
      livemode: mode === 'true',
      userId: session.userId,
      membershipId: membership.id,
      role: membership.role,
      isSigner: membership.isSigner,
      permissions: [...ROLE_PERMISSIONS[membership.role]],
    },
    cookie,
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  // Routes are collected as they are added and rejected in `onReady`, so `ready()` /
  // `listen()` fail; a throw in `onRoute` would surface wherever the route was added.
  app.decorateRequest('principal', undefined);
  app.decorateRequest('db', undefined);
  app.decorateRequest('rawBody', undefined);

  const unconfigured: string[] = [];
  app.addHook('onRoute', (route) => {
    if (isV1(route.url) && route.config?.auth === undefined) {
      unconfigured.push(`${String(route.method)} ${route.url}`);
    }
  });
  app.addHook('onReady', async () => {
    if (unconfigured.length > 0) {
      throw new Error(`routes without auth config: ${unconfigured.join(', ')}`);
    }
  });

  const requestLog = (req: FastifyRequest, p: Principal, fields: Record<string, unknown>) =>
    log('info', 'request', {
      requestId: req.id,
      method: req.method,
      route: req.routeOptions.url,
      ...(p.kind === 'user_session'
        ? { userId: p.userId }
        : { merchantId: p.merchantId, livemode: p.livemode }),
      principal: p.kind,
      ...fields,
    });

  // `onRequest`, so unauthenticated callers are refused before any body is read or validated.
  // Request signing (which needs the raw body) runs later, in `preValidation`.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = routeAuth(req.routeOptions.url, req.routeOptions.config.auth);
    if (auth === null || auth === 'public') return;

    const raw = bearerToken(req);
    const resolved = raw
      ? await resolvePrincipal(raw)
      : auth.principals.some((k) => COOKIE_KINDS.has(k))
        ? await resolveCookie(req, auth.principals)
        : null;
    if (!resolved) throw unauthorized('Invalid or missing credentials');
    const { principal, signing, cookie } = resolved;

    const denial = !auth.principals.includes(principal.kind)
      ? `This endpoint is not available to ${principal.kind} credentials`
      : // API keys (secret and publishable) carry scopes; session clients are confined by
        // the kind allowlist alone.
        auth.scope && 'scopes' in principal && !principal.scopes.includes(auth.scope)
        ? `Missing scope ${auth.scope}`
        : // Dashboard users carry their role's permissions.
          auth.permission &&
            principal.kind === 'dashboard_user' &&
            !principal.permissions.includes(auth.permission)
          ? `Missing permission ${auth.permission}`
          : cookie &&
              !SAFE_METHODS.has(req.method) &&
              !csrfMatches(cookie.token, header(req, CSRF_HEADER))
            ? 'Missing or invalid Tendr-CSRF header'
            : null;
    if (denial) {
      requestLog(req, principal, { outcome: 'forbidden', statusCode: 403 });
      throw forbidden(denial);
    }

    req.principal = principal;
    if (signing) signingConfigs.set(req, signing);
    if (principal.kind !== 'user_session') {
      req.db = scopedDb({ merchantId: principal.merchantId, livemode: principal.livemode });
    }
    // A slid session gets fresh cookies, so the browser's copy expires with the server's.
    if (cookie?.session.slid) {
      reply.header('set-cookie', sessionCookies(cookie.token, cookie.session.expiresAt));
    }
  });

  // Needs the raw body, so it runs after parsing. Secret keys only.
  // `preValidation`, so a schema validator can never answer 400 before the signature is checked.
  app.addHook('preValidation', async (req) => {
    if (req.principal?.kind !== 'secret_key') return;
    const cfg = signingConfigs.get(req);
    if (!cfg) return;
    const header = req.headers['tendr-signature'];
    const headerValue = Array.isArray(header) ? header.join(',') : header;
    const present = headerValue !== undefined && headerValue.trim() !== '';
    if (!cfg.signingRequired && !present) return;
    let secret: string | null = null;
    try {
      secret = cfg.signingSecretRef ? await getSecret(cfg.signingSecretRef) : null;
    } catch (err) {
      // A dangling ref or key-vault failure: a required key fails closed with 401, not 500.
      log('error', 'failed to load api key signing secret', {
        requestId: req.id,
        err: String(err),
      });
      if (cfg.signingRequired) throw signatureInvalid();
      throw err;
    }
    if (secret === null) {
      // No secret configured: a required key can never verify, so fail closed.
      if (cfg.signingRequired) throw signatureInvalid();
      return; // signing optional and nothing to verify against
    }
    const result = verifyRequestSignature(
      headerValue,
      req.rawBody ?? Buffer.alloc(0),
      secret,
      Math.floor(Date.now() / 1000),
    );
    if (result !== 'ok') throw signatureInvalid(`Request signature ${result}`);
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.principal) {
      requestLog(req, req.principal, { outcome: 'ok', statusCode: reply.statusCode });
    }
  });
};

export const auth = fp(authPlugin, { name: 'tendr-auth' });
