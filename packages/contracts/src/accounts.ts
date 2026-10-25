// Merchant accounts: roles, proposals and signer keys (merchant-accounts spec §2, §8).
import { z } from 'zod';
import type { MerchantUserRole } from './enums.js';

export const MerchantPermissionValues = [
  'account:read',
  'money:request',
  'team:manage',
  'settings:manage',
  'security:propose',
  'webhooks:resend',
] as const;
export type MerchantPermission = (typeof MerchantPermissionValues)[number];
export const MerchantPermissionSchema = z.enum(MerchantPermissionValues);

const VIEWER: readonly MerchantPermission[] = ['account:read'];
const FINANCE: readonly MerchantPermission[] = [...VIEWER, 'money:request'];
const ADMIN: readonly MerchantPermission[] = [
  ...FINANCE,
  'team:manage',
  'settings:manage',
  'webhooks:resend',
];
const OWNER: readonly MerchantPermission[] = [...ADMIN, 'security:propose'];

/**
 * What each dashboard role may do (spec §2). Roles gate the API only; moving money or changing
 * security still needs signer approvals on chain.
 */
export const ROLE_PERMISSIONS: Readonly<Record<MerchantUserRole, readonly MerchantPermission[]>> = {
  viewer: VIEWER,
  finance: FINANCE,
  admin: ADMIN,
  owner: OWNER,
};

export function can(role: MerchantUserRole, permission: MerchantPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** The contract's `Action` variants in snake_case, in their (fixed) Borsh order. */
export const ProposalKindValues = [
  'add_signer',
  'remove_signer',
  'add_signer_key',
  'remove_signer_key',
  'set_threshold',
  'set_origins',
  'rotate_recovery_key',
  'add_saved_address',
  'remove_saved_address',
  'set_limits',
  'set_refund_cap',
  'set_auto_sweep',
  'clear_auto_sweep',
  'withdraw',
  'refund',
  'upgrade',
  'set_settlement',
] as const;
export type ProposalKind = (typeof ProposalKindValues)[number];
export const ProposalKindSchema = z.enum(ProposalKindValues);

/** Kinds that change who controls the account: signers, keys, threshold, origins, recovery key. */
const SECURITY_KINDS: ReadonlySet<ProposalKind> = new Set(ProposalKindValues.slice(0, 7));

export function isSecurityKind(kind: ProposalKind): boolean {
  return SECURITY_KINDS.has(kind);
}

/**
 * `draft` exists only in Postgres (not yet submitted). `timelocked` is `pending` on chain with a
 * `ready_at` set. `executing` is the contract's in-flight state for withdrawals, refunds and
 * upgrades, until their callback lands.
 */
export const ProposalStatusValues = [
  'draft',
  'pending',
  'timelocked',
  'executing',
  'executed',
  'cancelled',
  'expired',
  'failed',
] as const;
export type ProposalStatus = (typeof ProposalStatusValues)[number];
export const ProposalStatusSchema = z.enum(ProposalStatusValues);

export const MerchantAccountStatusValues = ['provisioning', 'active', 'failed'] as const;
export type MerchantAccountStatus = (typeof MerchantAccountStatusValues)[number];
export const MerchantAccountStatusSchema = z.enum(MerchantAccountStatusValues);

export const RecoveryStatusValues = ['pending', 'cancelled', 'executed', 'failed'] as const;
export type RecoveryStatus = (typeof RecoveryStatusValues)[number];
export const RecoveryStatusSchema = z.enum(RecoveryStatusValues);

export const EmailTokenPurposeValues = ['verify', 'login', 'invite'] as const;
export type EmailTokenPurpose = (typeof EmailTokenPurposeValues)[number];
export const EmailTokenPurposeSchema = z.enum(EmailTokenPurposeValues);

/** Dashboard sessions slide: each use pushes `expires_at` this far out. */
export const DASHBOARD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const base64Of = (bytes: number) =>
  z.string().refine((s) => BASE64.test(s) && atob(s).length === bytes, {
    message: `must be standard padded base64 of ${bytes} bytes`,
  });

/**
 * A signer's public key, in the contract's serde shape (standard padded base64):
 * `{ "P256": <33-byte compressed SEC1> }` or `{ "Ed25519": <32 bytes> }`.
 */
export const SignerKeySchema = z.union([
  z.object({ P256: base64Of(33) }).strict(),
  z.object({ Ed25519: base64Of(32) }).strict(),
]);
export type SignerKey = z.infer<typeof SignerKeySchema>;
