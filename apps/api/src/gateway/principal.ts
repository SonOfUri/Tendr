// The authenticated caller of a request. Every principal except `user_session` is pinned to one
// merchant + mode, and the request's scoped data access (`req.db`) uses exactly that pair.
// A `user_session` (a signed-in person with no store selected) has no merchant and no `req.db`.
import type { MerchantPermission, MerchantUserRole, PrincipalKind, Scope } from '@tendr/contracts';
import type { FastifyRequest } from 'fastify';
import type { ScopedDb } from '../db/scoped.js';
import { forbidden, unauthorized } from '../lib/errors.js';

type Base = { merchantId: string; livemode: boolean };

export type Principal =
  | (Base & { kind: 'secret_key'; apiKeyId: string; scopes: Scope[] })
  | (Base & { kind: 'publishable_key'; apiKeyId: string; scopes: Scope[] })
  | (Base & { kind: 'session_client'; sessionId: string })
  // A person acting in one store (dashboard session cookie + Tendr-Merchant/Tendr-Livemode).
  | (Base & {
      kind: 'dashboard_user';
      userId: string;
      /** The `merchant_users` row (`usr_…`). */
      membershipId: string;
      role: MerchantUserRole;
      isSigner: boolean;
      permissions: MerchantPermission[];
    })
  // Resolved by the agent gateway (project 6); nothing produces it yet.
  | (Base & { kind: 'agent'; agentId: string })
  // A signed-in person with no store selected: signup, store switcher, invite acceptance.
  | { kind: 'user_session'; userId: string; sessionId: string };

/** A principal pinned to a merchant + mode (every kind but `user_session`). */
export type MerchantPrincipal = Exclude<Principal, { kind: 'user_session' }>;

/**
 * Per-route auth: `'public'`, or the principal kinds allowed plus optional checks:
 * - `scope`: required of API-key principals (they carry scopes);
 * - `permission`: required of `dashboard_user` principals (from their role, `ROLE_PERMISSIONS`).
 *   Other principal kinds are not affected by it.
 */
export type RouteAuth =
  { principals: PrincipalKind[]; scope?: Scope; permission?: MerchantPermission } | 'public';

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

/** The request's merchant-pinned principal; 401 when absent, 403 for a `user_session`. */
export function requireMerchantPrincipal(req: FastifyRequest): MerchantPrincipal {
  const p = requirePrincipal(req);
  if (p.kind === 'user_session') throw forbidden('Select a store (Tendr-Merchant header)');
  return p;
}

export type DashboardUserPrincipal = Extract<Principal, { kind: 'dashboard_user' }>;

/** The request's `dashboard_user` principal (a person acting in one store); 403 otherwise. */
export function requireDashboardUser(req: FastifyRequest): DashboardUserPrincipal {
  const p = requirePrincipal(req);
  if (p.kind !== 'dashboard_user') throw forbidden('This endpoint needs a store (Tendr-Merchant)');
  return p;
}

/** The person behind a dashboard request (`dashboard_user` or `user_session`); 401 otherwise. */
export function requirePerson(req: FastifyRequest): { userId: string } {
  const p = requirePrincipal(req);
  if (p.kind !== 'dashboard_user' && p.kind !== 'user_session') throw unauthorized();
  return { userId: p.userId };
}

/**
 * The credential identity a principal acts under — the key for rate limits and idempotency.
 * A `dashboard_user` acts under its membership (`usr_…`), so its limits and idempotency keys are
 * per person per store; a `user_session` under the person (`per_…`).
 */
export function principalRef(p: Principal): string {
  switch (p.kind) {
    case 'secret_key':
    case 'publishable_key':
      return p.apiKeyId;
    case 'session_client':
      return p.sessionId;
    case 'dashboard_user':
      return p.membershipId;
    case 'user_session':
      return p.userId;
    case 'agent':
      return p.agentId;
  }
}
