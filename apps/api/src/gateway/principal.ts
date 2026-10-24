// The authenticated caller of a request. Every principal is pinned to one merchant + mode,
// and the request's scoped data access uses exactly that pair.
import type { MerchantUserRole, PrincipalKind, Scope } from '@tendr/contracts';
import type { FastifyRequest } from 'fastify';
import type { ScopedDb } from '../db/scoped.js';
import { unauthorized } from '../lib/errors.js';

type Base = { merchantId: string; livemode: boolean };

export type Principal =
  | (Base & { kind: 'secret_key'; apiKeyId: string; scopes: Scope[] })
  | (Base & { kind: 'publishable_key'; apiKeyId: string; scopes: Scope[] })
  | (Base & { kind: 'session_client'; sessionId: string })
  // Resolved by the dashboard login (project 3); nothing produces it yet.
  | (Base & { kind: 'dashboard_user'; userId: string; role: MerchantUserRole })
  // Resolved by the agent gateway (project 6); nothing produces it yet.
  | (Base & { kind: 'agent'; agentId: string });

/** Per-route auth: `'public'`, or the principal kinds allowed plus an optional scope. */
export type RouteAuth = { principals: PrincipalKind[]; scope?: Scope } | 'public';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    principal?: Principal;
    db?: ScopedDb;
    /** Raw bytes of a JSON request body, captured by the content-type parser. */
    rawBody?: Buffer;
  }
}

/** The request's principal; throws 401 on a route that did not authenticate. */
export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

/** The credential identity a principal acts under — the key for rate limits and idempotency. */
export function principalRef(p: Principal): string {
  switch (p.kind) {
    case 'secret_key':
    case 'publishable_key':
      return p.apiKeyId;
    case 'session_client':
      return p.sessionId;
    case 'dashboard_user':
      return p.userId;
    case 'agent':
      return p.agentId;
  }
}
