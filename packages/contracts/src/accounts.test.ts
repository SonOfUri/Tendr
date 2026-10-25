import { describe, expect, it } from 'vitest';
import {
  ProposalKindValues,
  ProposalStatusValues,
  ROLE_PERMISSIONS,
  SignerKeySchema,
  can,
  isSecurityKind,
} from './accounts.js';
import { MerchantUserRoleValues } from './enums.js';

describe('ROLE_PERMISSIONS', () => {
  it('a viewer lacks money:request; finance has it', () => {
    expect(can('viewer', 'money:request')).toBe(false);
    expect(can('finance', 'money:request')).toBe(true);
  });

  it('only the owner has security:propose', () => {
    const holders = MerchantUserRoleValues.filter((r) => can(r, 'security:propose'));
    expect(holders).toEqual(['owner']);
  });

  it('every role has account:read', () => {
    for (const role of MerchantUserRoleValues) expect(can(role, 'account:read')).toBe(true);
  });

  it('follows the spec §2 ladder exactly', () => {
    expect(ROLE_PERMISSIONS.viewer).toEqual(['account:read']);
    expect(ROLE_PERMISSIONS.finance).toEqual(['account:read', 'money:request']);
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual(
      ['account:read', 'money:request', 'settings:manage', 'team:manage', 'webhooks:resend'].sort(),
    );
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual(
      [...ROLE_PERMISSIONS.admin, 'security:propose'].sort(),
    );
  });
});

describe('proposals', () => {
  it('kinds are the contract Action variants in order', () => {
    expect(ProposalKindValues).toEqual([
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
    ]);
  });

  it('isSecurityKind is true for exactly the first seven kinds', () => {
    expect(ProposalKindValues.filter(isSecurityKind)).toEqual(ProposalKindValues.slice(0, 7));
  });

  it('statuses include the in-flight executing state', () => {
    expect(ProposalStatusValues).toEqual([
      'draft',
      'pending',
      'timelocked',
      'executing',
      'executed',
      'cancelled',
      'expired',
      'failed',
    ]);
  });
});

describe('SignerKeySchema', () => {
  const b64 = (n: number) => btoa(String.fromCharCode(...new Array<number>(n).fill(2)));

  it('accepts the contract serde shapes', () => {
    expect(SignerKeySchema.parse({ P256: b64(33) })).toEqual({ P256: b64(33) });
    expect(SignerKeySchema.parse({ Ed25519: b64(32) })).toEqual({ Ed25519: b64(32) });
  });

  it('rejects wrong lengths, unpadded base64 and unknown variants', () => {
    expect(SignerKeySchema.safeParse({ P256: b64(32) }).success).toBe(false);
    expect(SignerKeySchema.safeParse({ Ed25519: b64(32).replace(/=+$/, '') }).success).toBe(false);
    expect(SignerKeySchema.safeParse({ P256: '!'.repeat(44) }).success).toBe(false);
    expect(SignerKeySchema.safeParse({ Secp256k1: b64(33) }).success).toBe(false);
    expect(SignerKeySchema.safeParse({ P256: b64(33), Ed25519: b64(32) }).success).toBe(false);
  });
});
