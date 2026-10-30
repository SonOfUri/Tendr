import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createCredential, createMerchant, createUser, resetDb } from '../test/helpers.js';
import { loadEnv } from '../env.js';
import { envReservedLabels, isReservedLabel } from './reserved-labels.js';
import { createStore, slugBase } from './signup.js';

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
      expect(isReservedLabel(reserved), reserved).toBe(true);
      const s = slugBase(reserved);
      expect(s, reserved).toBe(`store-${reserved}`);
      expect(s).toMatch(NEAR_LABEL);
    }
    expect(slugBase('Intents Mock')).toBe('store-intents-mock');
    expect(slugBase('TENDR')).toBe('store-tendr');
    // `tendr*` is a reserved prefix: nothing under Tendr's parents may read as Tendr.
    expect(slugBase('Tendr Coffee')).toBe('store-tendr-coffee');

    const user = await createUser();
    await createCredential(user.id);
    const { merchant } = await createStore(user.id, 'Funding NEAR');
    expect(merchant.slug).toBe('store-funding-near');
    const account = await prisma.merchantAccount.findFirstOrThrow({
      where: { merchantId: merchant.id },
    });
    expect(account.nearAccountId).toBe('store-funding-near.tendr.testnet');
  });

  it('C-1: a store named "Fees" never takes Tendr\'s fee account, in either mode', async () => {
    for (const name of ['Fees', 'fees', 'FEE', 'Treasury', 'Support', 'Root', 'System', 'Mail']) {
      expect(slugBase(name), name).toMatch(/^store-/);
    }
    const user = await createUser();
    await createCredential(user.id);
    const { merchant } = await createStore(user.id, 'Fees');
    expect(merchant.slug).toBe('store-fees');
    const account = await prisma.merchantAccount.findFirstOrThrow({
      where: { merchantId: merchant.id },
    });
    expect(account.nearAccountId).toBe('store-fees.tendr.testnet');
    expect(account.nearAccountId).not.toBe(loadEnv().FEE_ACCOUNT_TEST);
  });

  it('C-1: the static list, the prefix rules and env-derived labels are all reserved', () => {
    for (const label of [
      'fees',
      'fee',
      'revenue',
      'treasury',
      'ops',
      'operator',
      'operators',
      'support',
      'help',
      'billing',
      'refund',
      'refunds',
      'security',
      'status',
      'docs',
      'mail',
      'email',
      'webhooks',
      'hooks',
      'relay',
      'sponsor',
      'paymaster',
      'settlement',
      'settlements',
      'escrow',
      'vault',
      'root',
      'system',
      'internal',
      'staging',
      'sandbox',
      'dev',
      'near',
      'testnet',
      'tendrpay',
      'merchant',
      'merchants',
      'wallet',
      'wallets',
      'oneclick',
      '1click',
      'swap',
      'bridge',
      'relayer-near',
      'relayer-evm',
      'solver-hot',
      'usdc',
      // prefix rules
      'gas-tron',
      'gas-evm',
      'gas-sol',
      'fee-usdc',
      'fees-live',
      'intents2',
      'intents-x',
      'tendr-ops',
      'tendrx',
    ]) {
      expect(isReservedLabel(label), label).toBe(true);
    }
    // Session ids live under /pay/[id]: no store label may look like one.
    expect(isReservedLabel('ses_01jabc')).toBe(true);
    expect(isReservedLabel('ses-01jabc')).toBe(true);
    expect(slugBase('ses_01J9ZK')).toMatch(/^store-/);
    for (const label of ['acme', 'coffee', 'feesh', 'gasket', 'store-fees', 'store-tendr-2']) {
      expect(isReservedLabel(label), label).toBe(false);
    }
    // A renamed fee account is reserved from env, whatever its label.
    const e = loadEnv({
      ...process.env,
      FEE_ACCOUNT_LIVE: 'collect.tendr.near',
      FEE_ACCOUNT_TEST: 'sub.take.tendr.testnet',
      INTENTS_CONTRACT_TEST: 'verifier-x.tendr.testnet',
    });
    try {
      expect([...envReservedLabels(e)].sort()).toEqual(['collect', 'take', 'verifier-x']);
      expect(isReservedLabel('collect', e)).toBe(true);
      expect(isReservedLabel('take', e)).toBe(true);
      expect(isReservedLabel('verifier-x', e)).toBe(true);
      expect(slugBase('Collect')).toBe('store-collect');
    } finally {
      loadEnv();
    }
  });

  it('C40: a `-store` suffix never admits a reserved base; reserved names map to `store-…`', () => {
    for (const label of [
      'tendr-store',
      'fees-store',
      'intents-store',
      'fees-store-2',
      'admin-store',
    ]) {
      expect(isReservedLabel(label), label).toBe(true);
    }
    expect(slugBase('Fees Store')).toBe('store-fees-store');
    expect(slugBase('Admin')).toBe('store-admin');
    // The mapped form is never itself reserved, and a long name stays within the base length.
    expect(isReservedLabel('store-fees')).toBe(false);
    const long = slugBase(`tendr ${'x'.repeat(40)}`);
    expect(long.startsWith('store-tendr-')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(28);
    expect(isReservedLabel(long)).toBe(false);
  });

  it('C-1: no existing store slug is reserved (one-off check over the merchants table)', async () => {
    // The check itself: run against every merchants.slug. Here it runs on the test DB's stores.
    const user = await createUser();
    await createCredential(user.id);
    await createStore(user.id, 'Acme');
    const slugs = await prisma.merchant.findMany({ select: { slug: true } });
    expect(slugs.filter((m) => isReservedLabel(m.slug))).toEqual([]);
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
