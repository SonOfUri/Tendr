import type { Merchant, User } from '@prisma/client';
import { MAX_CHECKOUT_DOMAINS } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { setWebhookResolver } from '../checkout/webhooks.js';
import { flushLastUsed } from '../gateway/auth.js';
import { sha256 } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { getSecret } from '../secrets/secrets.js';
import { createMerchant, createUser, resetDb } from '../test/helpers.js';
import {
  CONNECTION_KEY_SCOPES,
  ConnectError,
  createConnection,
  revokeConnection,
  siteOriginOf,
} from './connections.js';

const connect = (merchantId: string, userId: string, siteUrl: string) =>
  prisma.$transaction((tx) =>
    createConnection(tx, { merchantId, userId, siteUrl, platform: 'woocommerce' }),
  );

const revoke = (connectionId: string, by: 'site' | 'dashboard' = 'site') =>
  prisma.$transaction((tx) => revokeConnection(tx, connectionId, by));

const domainsOf = async (merchantId: string) =>
  (await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } })).checkoutDomains;

describe('connections', () => {
  let m: Merchant;
  let u: User;

  beforeEach(async () => {
    await resetDb();
    m = await createMerchant();
    u = await createUser();
    // Live endpoints are checked against DNS; tests never use the network.
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    setWebhookResolver(null);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('createConnection issues two secret keys whose sha256 match stored rows and whose scopes equal the list above', async () => {
    const { connection, issued } = await connect(m.id, u.id, 'https://shop.example.com/store/');
    expect(connection.id).toMatch(/^con_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(connection).toMatchObject({
      merchantId: m.id,
      platform: 'woocommerce',
      siteOrigin: 'https://shop.example.com',
      connectedByUserId: u.id,
      revokedAt: null,
    });
    expect([...CONNECTION_KEY_SCOPES]).toEqual([
      'sessions:read',
      'sessions:write',
      'payments:read',
      'refunds:write',
      'events:read',
    ]);

    for (const [mode, livemode] of [
      ['test', false],
      ['live', true],
    ] as const) {
      const creds = issued[mode];
      expect(creds.secretKey.startsWith(livemode ? 'tdr_live_' : 'tdr_test_')).toBe(true);
      expect(creds.publishableKey.startsWith(livemode ? 'tdr_pk_live_' : 'tdr_pk_test_')).toBe(
        true,
      );
      const secret = await prisma.apiKey.findUniqueOrThrow({
        where: { keyHash: sha256(creds.secretKey) },
      });
      expect(secret).toMatchObject({
        merchantId: m.id,
        livemode,
        kind: 'secret',
        connectionId: connection.id,
        revokedAt: null,
      });
      expect(secret.scopes).toEqual([...CONNECTION_KEY_SCOPES]);
      const publishable = await prisma.apiKey.findUniqueOrThrow({
        where: { keyHash: sha256(creds.publishableKey) },
      });
      expect(publishable).toMatchObject({
        livemode,
        kind: 'publishable',
        connectionId: connection.id,
      });
    }
    expect(await prisma.apiKey.count({ where: { connectionId: connection.id } })).toBe(4);
    // No raw key or signing secret is stored anywhere in plaintext.
    const dump = JSON.stringify([
      await prisma.apiKey.findMany(),
      await prisma.secret.findMany(),
      await prisma.webhookEndpoint.findMany(),
      await prisma.connection.findMany(),
    ]);
    for (const raw of [
      issued.test.secretKey,
      issued.live.secretKey,
      issued.test.publishableKey,
      issued.live.publishableKey,
      issued.test.webhookSecret,
      issued.live.webhookSecret,
    ]) {
      expect(dump).not.toContain(raw);
    }
  });

  it('createConnection creates one webhook endpoint per mode bound to the connection', async () => {
    const { connection, issued } = await connect(m.id, u.id, 'https://shop.example.com/store/');
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { connectionId: connection.id },
      orderBy: { livemode: 'asc' },
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints.map((e) => e.livemode)).toEqual([false, true]);
    for (const e of endpoints) {
      expect(e).toMatchObject({
        merchantId: m.id,
        url: 'https://shop.example.com/store/wp-json/tendr/v1/webhook',
        events: ['*'],
        active: true,
      });
      // The signing secret is kept in the vault and matches the one handed out.
      expect(await getSecret(e.secretRef)).toBe(
        e.livemode ? issued.live.webhookSecret : issued.test.webhookSecret,
      );
    }
    expect(issued.test.webhookSecret).not.toBe(issued.live.webhookSecret);
  });

  it('createConnection adds the origin once and records addedDomain', async () => {
    const first = await connect(m.id, u.id, 'https://shop.example.com/store/');
    expect(first.connection.addedDomain).toBe('https://shop.example.com');
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);

    // A second site on the same origin does not add it again, and did not add it.
    const second = await connect(m.id, u.id, 'https://shop.example.com/other');
    expect(second.connection.addedDomain).toBeNull();
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);
  });

  it('createConnection does not record addedDomain when the origin was already present', async () => {
    await prisma.merchant.update({
      where: { id: m.id },
      data: { checkoutDomains: ['https://shop.example.com'] },
    });
    const { connection } = await connect(m.id, u.id, 'https://shop.example.com');
    expect(connection.addedDomain).toBeNull();
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);
  });

  it('createConnection throws DOMAIN_LIMIT at 20 domains', async () => {
    const full = Array.from(
      { length: MAX_CHECKOUT_DOMAINS },
      (_, i) => `https://s${i}.example.com`,
    );
    expect(full).toHaveLength(20);
    await prisma.merchant.update({ where: { id: m.id }, data: { checkoutDomains: full } });

    const err = await connect(m.id, u.id, 'https://shop.example.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).toMatchObject({ reason: 'DOMAIN_LIMIT', code: 'DOMAIN_LIMIT', status: 409 });
    // Nothing was created.
    expect(await prisma.connection.count()).toBe(0);
    expect(await prisma.apiKey.count()).toBe(0);
    expect(await prisma.webhookEndpoint.count()).toBe(0);
    expect(await prisma.secret.count()).toBe(0);
    expect(await domainsOf(m.id)).toEqual(full);

    // An origin already on the full list needs no new slot.
    const ok = await connect(m.id, u.id, 'https://s3.example.com/shop');
    expect(ok.connection.addedDomain).toBeNull();
  });

  it('revokeConnection makes the keys fail auth (401) and keeps a hand-added domain', async () => {
    await prisma.merchant.update({
      where: { id: m.id },
      data: { checkoutDomains: ['https://shop.example.com'] },
    });
    const { connection, issued } = await connect(m.id, u.id, 'https://shop.example.com');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app: FastifyInstance = await buildApp();
    await app.ready();
    try {
      const ping = (raw: string) =>
        app.inject({ url: '/v1/ping', headers: { authorization: `Bearer ${raw}` } });
      for (const raw of [
        issued.test.secretKey,
        issued.live.secretKey,
        issued.test.publishableKey,
      ]) {
        expect((await ping(raw)).statusCode).toBe(200);
      }

      await revoke(connection.id, 'dashboard');

      for (const raw of [
        issued.test.secretKey,
        issued.live.secretKey,
        issued.test.publishableKey,
        issued.live.publishableKey,
      ]) {
        expect((await ping(raw)).statusCode).toBe(401);
      }
    } finally {
      await flushLastUsed();
      await app.close();
      logSpy.mockRestore();
    }

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.revokedAt).not.toBeNull();
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { connectionId: connection.id },
    });
    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((e) => !e.active)).toBe(true);
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);

    // Revoking again is a no-op.
    await revoke(connection.id);
    expect(
      (await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } })).revokedAt,
    ).toEqual(row.revokedAt);
  });

  it('revokeConnection removes addedDomain only when no other live connection shares the origin', async () => {
    await prisma.merchant.update({
      where: { id: m.id },
      data: { checkoutDomains: ['https://hand.example.com'] },
    });
    const a = await connect(m.id, u.id, 'https://shop.example.com');
    const b = await connect(m.id, u.id, 'https://shop.example.com/b');
    expect(a.connection.addedDomain).toBe('https://shop.example.com');
    expect(b.connection.addedDomain).toBeNull();

    // B is still live on the origin A added: the domain stays.
    await revoke(a.connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual(['https://hand.example.com', 'https://shop.example.com']);

    // A connection that added its domain and is alone on it takes it away.
    const c = await connect(m.id, u.id, 'https://other.example.com');
    expect(c.connection.addedDomain).toBe('https://other.example.com');
    await revoke(c.connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual(['https://hand.example.com', 'https://shop.example.com']);
  });

  it("revokeConnection by:'site' keeps addedDomain", async () => {
    const { connection } = await connect(m.id, u.id, 'https://shop.example.com');
    await revoke(connection.id, 'site');
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.addedDomain).toBe('https://shop.example.com');
  });

  it('a dashboard removal after a site revoke removes the domain when no peer uses it', async () => {
    const { connection, issued } = await connect(m.id, u.id, 'https://shop.example.com');
    await revoke(connection.id, 'site');
    const revokedAt = (await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } }))
      .revokedAt;

    await revoke(connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual([]);
    const row = await prisma.connection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.revokedAt).toEqual(revokedAt);
    expect(row.addedDomain).toBeNull();
    expect(
      await prisma.apiKey.findUniqueOrThrow({ where: { keyHash: sha256(issued.test.secretKey) } }),
    ).toMatchObject({ revokedAt: revokedAt });

    // Running the removal again changes nothing.
    await prisma.merchant.update({
      where: { id: m.id },
      data: { checkoutDomains: ['https://shop.example.com'] }, // re-added by hand meanwhile
    });
    await revoke(connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);
  });

  it('a dashboard removal after a site revoke keeps the domain when a live peer shares the origin', async () => {
    const a = await connect(m.id, u.id, 'https://shop.example.com');
    await connect(m.id, u.id, 'https://shop.example.com/b');
    await revoke(a.connection.id, 'site');
    await revoke(a.connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);
  });

  it('a dashboard removal hands addedDomain over to a live peer on the same origin', async () => {
    const a = await connect(m.id, u.id, 'https://shop.example.com');
    const b = await connect(m.id, u.id, 'https://shop.example.com/b');
    // A revoked peer on the origin is not an owner candidate.
    const c = await connect(m.id, u.id, 'https://shop.example.com/c');
    await revoke(c.connection.id, 'dashboard');

    await revoke(a.connection.id, 'dashboard');
    const owner = async (id: string) =>
      (await prisma.connection.findUniqueOrThrow({ where: { id } })).addedDomain;
    expect(await owner(a.connection.id)).toBeNull();
    expect(await owner(b.connection.id)).toBe('https://shop.example.com');
    expect(await owner(c.connection.id)).toBeNull();
    expect(await domainsOf(m.id)).toEqual(['https://shop.example.com']);

    // The new owner, removed while alone on the origin, takes the domain away.
    await revoke(b.connection.id, 'dashboard');
    expect(await domainsOf(m.id)).toEqual([]);
  });

  it('C7: the domain hand-over picks the oldest live peer, by id when created at the same time', async () => {
    const a = await connect(m.id, u.id, 'https://shop.example.com');
    const b = await connect(m.id, u.id, 'https://shop.example.com/b');
    const c = await connect(m.id, u.id, 'https://shop.example.com/c');
    const at = new Date('2026-01-01T00:00:00Z');
    // Same creation time; b is rewritten last, so a plain scan meets c's row first.
    await prisma.connection.update({ where: { id: c.connection.id }, data: { createdAt: at } });
    await prisma.connection.update({ where: { id: b.connection.id }, data: { createdAt: at } });
    expect(b.connection.id < c.connection.id).toBe(true);
    await revoke(a.connection.id, 'dashboard');
    const owner = async (id: string) =>
      (await prisma.connection.findUniqueOrThrow({ where: { id } })).addedDomain;
    expect(await owner(b.connection.id)).toBe('https://shop.example.com');
    expect(await owner(c.connection.id)).toBeNull();
  });

  it("siteOriginOf('https://shop.example.com/store/') → { origin:'https://shop.example.com', path:'/store' }", () => {
    expect(siteOriginOf('https://shop.example.com/store/')).toEqual({
      origin: 'https://shop.example.com',
      path: '/store',
    });
    expect(siteOriginOf('https://Shop.Example.com:443')).toEqual({
      origin: 'https://shop.example.com',
      path: '',
    });
  });

  it("siteOriginOf('http://localhost:8888') accepted outside production", () => {
    expect(siteOriginOf('http://localhost:8888')).toEqual({
      origin: 'http://localhost:8888',
      path: '',
    });
    expect(() => siteOriginOf('http://shop.example.com')).toThrow(ConnectError);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => siteOriginOf('http://localhost:8888')).toThrow(ConnectError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("siteOriginOf('ftp://x') rejected", () => {
    for (const bad of [
      'ftp://x',
      'not a url',
      'https://user:pw@shop.example.com',
      'javascript:alert(1)',
    ]) {
      expect(() => siteOriginOf(bad)).toThrow(ConnectError);
    }
  });
});
