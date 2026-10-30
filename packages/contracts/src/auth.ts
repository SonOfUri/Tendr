import { z } from 'zod';

export const PrincipalKindValues = [
  'secret_key',
  'publishable_key',
  'session_client',
  'dashboard_user',
  // A signed-in person with no store selected (signup, store switcher, invite acceptance).
  'user_session',
  'agent',
] as const;
export type PrincipalKind = (typeof PrincipalKindValues)[number];
export const PrincipalKindSchema = z.enum(PrincipalKindValues);

export const ScopeValues = [
  'sessions:read',
  'sessions:write',
  'payments:read',
  'refunds:write',
  'payment_links:read',
  'payment_links:write',
  'webhooks:read',
  'webhooks:write',
  'events:read',
  'themes:read',
  'themes:write',
] as const;
export type Scope = (typeof ScopeValues)[number];
export const ScopeSchema = z.enum(ScopeValues);
export const ALL_SCOPES: readonly Scope[] = ScopeValues;

/** Dashboard session cookie (HttpOnly): the raw session token; only its sha256 is stored. */
export const SESSION_COOKIE = 'tendr_session';
/** Readable CSRF cookie; the dashboard echoes it in `Tendr-CSRF` on mutating requests. */
export const CSRF_COOKIE = 'tendr_csrf';
/** Header names are lower-case, as Node delivers them. */
export const CSRF_HEADER = 'tendr-csrf';
/** The store a dashboard request acts on (`mer_…`). */
export const MERCHANT_HEADER = 'tendr-merchant';
/** The mode a dashboard request acts in: `true` (live) or `false` (test). */
export const LIVEMODE_HEADER = 'tendr-livemode';
