import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createCredential, createMerchant, createUser, resetDb } from '../test/helpers.js';
import { RESERVED_SLUGS, createStore, slugBase } from './signup.js';

/** A NEAR sub-account label: lower-case alphanumerics separated by single `-`/`_`. */
const NEAR_LABEL = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

describe('signup', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('signup_creates_person_store_and_owner_signer_membership', async () => {
    const user = await createUser();
    await createCredential(user.id);
    const { merchant, membership } = await createStore(user.id, 'Acme Coffee');
    expect(merchant).toMatchObject({ name: 'Acme Coffee', slug: 'acme-coffee', status: 'active' });
    expect(merchant.id).toMatch(/^mer_/);
    expect(membership).toMatchObject({
      merchantId: merchant.id,
      userId: user.id,
      role: 'owner',
      isSigner: true,
    });
    expect(membership.id).toMatch(/^usr_/);
  });

  it('refuses to create a store before the person has an active passkey', async () => {
    const user = await createUser();
    await expect(createStore(user.id, 'Acme')).rejects.toMatchObject({ status: 409 });
    const cred = await createCredential(user.id, { revokedAt: new Date() });
    expect(cred.revokedAt).not.toBeNull();
    await expect(createStore(user.id, 'Acme')).rejects.toMatchObject({ status: 409 });
    expect(await prisma.merchant.count()).toBe(0);
  });

  it('reserved slugs (Tendr accounts and names) are never given to a store', async () => {
    for (const reserved of [
      'intents-mock',
      'intents',
      'relayer',
      'relayer-accounts',
      'funding',
      'funding-near',
      'tendr',
      'admin',
      'api',
      'www',
      'app',
      'dashboard',
      'pay',
      'checkout',
      'mock',
      'test',
      'solver',
      'gas',
    ]) {
      expect(RESERVED_SLUGS.has(reserved), reserved).toBe(true);
      const s = slugBase(reserved);
      expect(s, reserved).toBe(`${reserved}-store`);
      expect(s).toMatch(NEAR_LABEL);
    }
    expect(slugBase('Intents Mock')).toBe('intents-mock-store');
    expect(slugBase('TENDR')).toBe('tendr-store');
    expect(slugBase('Tendr Coffee')).toBe('tendr-coffee');

    const user = await createUser();
    await createCredential(user.id);
    const { merchant } = await createStore(user.id, 'Funding NEAR');
    expect(merchant.slug).toBe('funding-near-store');
    const account = await prisma.merchantAccount.findFirstOrThrow({
      where: { merchantId: merchant.id },
    });
    expect(account.nearAccountId).toBe('funding-near-store.tendr.testnet');
  });

  it('slug_collision_gets_suffix', async () => {
    const user = await createUser();
    await createCredential(user.id);
    expect((await createStore(user.id, 'Acme')).merchant.slug).toBe('acme');
    expect((await createStore(user.id, 'ACME!')).merchant.slug).toBe('acme-2');
    expect((await createStore(user.id, 'acme')).merchant.slug).toBe('acme-3');
  });

  it('concurrent stores with the same name get distinct slugs', async () => {
    const user = await createUser();
    await createCredential(user.id);
    const stores = await Promise.all(
      Array.from({ length: 4 }, () => createStore(user.id, 'Same Name')),
    );
    expect(new Set(stores.map((s) => s.merchant.slug)).size).toBe(4);
  });

  it('slugs are 3–32 chars of [a-z0-9-] and valid NEAR labels', async () => {
    const cases: Array<[string, string]> = [
      ['Acme Coffee', 'acme-coffee'],
      ['  Café  Ünïcode — Store ', 'cafe-unicode-store'],
      ['a', 'a-store'],
      ['!!!', 'store'],
      ['x'.repeat(80), 'x'.repeat(28)],
      ['under_score..dots', 'under-score-dots'],
    ];
    for (const [name, slug] of cases) {
      const s = slugBase(name);
      expect(s, name).toBe(slug);
      expect(s).toMatch(NEAR_LABEL);
      expect(s.length).toBeGreaterThanOrEqual(3);
      expect(s.length).toBeLessThanOrEqual(28); // room for a "-NNN" suffix within 32
    }
    // A suffixed slug stays within 32 characters.
    const user = await createUser();
    await createCredential(user.id);
    await createMerchant({ slug: 'x'.repeat(28) });
    const { merchant } = await createStore(user.id, 'x'.repeat(80));
    expect(merchant.slug).toBe(`${'x'.repeat(28)}-2`);
    expect(merchant.slug).toMatch(NEAR_LABEL);
    expect(merchant.slug.length).toBeLessThanOrEqual(32);
  });
});
