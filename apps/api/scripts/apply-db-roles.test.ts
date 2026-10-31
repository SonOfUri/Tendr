import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { APPLY_ROLES_FAILED, applyDbRoles, runApplyDbRoles } from './apply-db-roles.js';

const ownerUrl = process.env.DATABASE_URL as string;
// A password with a quote and a backslash proves the literal is escaped, not interpolated.
const password = `pw'${randomBytes(6).toString('hex')}\\x`;

function appUrl(): string {
  const u = new URL(ownerUrl);
  u.username = 'tendr_app';
  u.password = password;
  return u.toString();
}

describe('apply-db-roles', () => {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  afterAll(async () => {
    // The role is cluster-wide: leave it passwordless rather than with this test's password.
    const owner = new PrismaClient({ datasourceUrl: ownerUrl });
    await owner.$executeRawUnsafe('ALTER ROLE tendr_app PASSWORD NULL');
    await owner.$disconnect();
  });

  it('creates a role that reads and writes rows but cannot change the schema; idempotent', async () => {
    await applyDbRoles({ url: ownerUrl, appPassword: password, log });
    await applyDbRoles({ url: ownerUrl, appPassword: password, log });
    expect(logs.join('\n')).not.toContain(password);

    const app = new PrismaClient({ datasourceUrl: appUrl() });
    try {
      const rows = await app.$queryRawUnsafe<{ u: string }[]>('SELECT current_user AS u');
      expect(rows[0]?.u).toBe('tendr_app');
      await app.$executeRawUnsafe('DELETE FROM "webauthn_challenges" WHERE false');
      await app.$queryRawUnsafe('SELECT count(*) FROM "users"');
      await expect(app.$executeRawUnsafe('CREATE TABLE zz_nope (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.$executeRawUnsafe('DROP TABLE "users"')).rejects.toThrow(
        /must be owner|permission denied/,
      );
      await expect(app.$executeRawUnsafe('UPDATE "events" SET type = type')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.$queryRawUnsafe('SELECT * FROM "_prisma_migrations"')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.$disconnect();
    }
  });

  it('without a password still creates the role and says so', async () => {
    const out: string[] = [];
    await applyDbRoles({ url: ownerUrl, appPassword: undefined, log: (m) => out.push(m) });
    expect(out.join('\n')).toMatch(/DATABASE_APP_PASSWORD not set/);
  });

  it('on failure prints a fixed line, never the error (which could echo ALTER ROLE ... PASSWORD)', async () => {
    const out: string[] = [];
    const code = await runApplyDbRoles({
      url: ownerUrl,
      appPassword: password,
      log: (m) => out.push(m),
      error: (m) => out.push(m),
      apply: async () => {
        throw new Error(`syntax error at or near "ALTER ROLE tendr_app PASSWORD '${password}'"`);
      },
    });
    expect(code).toBe(1);
    expect(out).toEqual([APPLY_ROLES_FAILED]);
    expect(APPLY_ROLES_FAILED).toBe('applying database roles failed');
    expect(out.join('\n')).not.toContain(password);
  });

  it('returns 0 when the roles are applied', async () => {
    const out: string[] = [];
    const code = await runApplyDbRoles({
      url: ownerUrl,
      appPassword: undefined,
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    expect(code).toBe(0);
    expect(out.join('\n')).not.toContain(APPLY_ROLES_FAILED);
  });
});
