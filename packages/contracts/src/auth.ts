import { z } from 'zod';

export const PrincipalKindValues = [
  'secret_key',
  'publishable_key',
  'session_client',
  'dashboard_user',
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
] as const;
export type Scope = (typeof ScopeValues)[number];
export const ScopeSchema = z.enum(ScopeValues);
export const ALL_SCOPES: readonly Scope[] = ScopeValues;
