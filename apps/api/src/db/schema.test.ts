import { Prisma } from '@prisma/client';
import { ulid } from 'ulid';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import {
  MERCHANT_OWNED_MODELS,
  createApiKey,
  createMerchant,
  createRow,
  minimalSession,
  resetDb,
} from '../test/helpers.js';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function insertEvent(): Promise<string> {
  const id = `evt_${ulid()}`;
  await prisma.$executeRaw`INSERT INTO events (id, aggregate_type, aggregate_id, type, payload) VALUES (${id}, 'session', 'ses_x', 't', '{}')`;
  return id;
}

describe('foundation schema', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('events rows cannot be updated', async () => {
    const id = await insertEvent();
    await expect(prisma.$executeRaw`UPDATE events SET type = 'x' WHERE id = ${id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('events rows cannot be deleted', async () => {
    const id = await insertEvent();
    await expect(prisma.$executeRaw`DELETE FROM events WHERE id = ${id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('sessions.external_ref is unique per merchant and mode', async () => {
    const m = await createMerchant();
    await prisma.session.create({
      data: minimalSession({ merchantId: m.id, livemode: false, externalRef: 'order-1' }),
    });
    const dup = prisma.session.create({
      data: minimalSession({ merchantId: m.id, livemode: false, externalRef: 'order-1' }),
    });
    await expect(dup).rejects.toSatisfy(isUniqueViolation);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: true, externalRef: 'order-1' }),
      }),
    ).resolves.toMatchObject({ externalRef: 'order-1', livemode: true });
  });

  it("a session cannot reference another merchant's theme or payment link", async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const themeB = await createRow('CheckoutTheme', b.id, false);
    const linkB = await createRow('PaymentLink', b.id, false);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: a.id, livemode: false, themeId: themeB.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: a.id, livemode: false, paymentLinkId: linkB.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('a live session cannot reference a test-mode payment link', async () => {
    const m = await createMerchant();
    const testLink = await createRow('PaymentLink', m.id, false);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: true, paymentLinkId: testLink.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: false, paymentLinkId: testLink.id }),
      }),
    ).resolves.toMatchObject({ paymentLinkId: testLink.id });
  });

  it('payment link slugs are unique per merchant and mode', async () => {
    const m = await createMerchant();
    await createRow('PaymentLink', m.id, false, { slug: 'classic-tote' });
    await createRow('PaymentLink', m.id, true, { slug: 'classic-tote' });
    await expect(createRow('PaymentLink', m.id, false, { slug: 'classic-tote' })).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('no column stores private keys', async () => {
    const cols = await prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_schema='public'`;
    expect(
      cols.map((c) => c.column_name).filter((c) => /private|secret_key|mnemonic|seed/.test(c)),
    ).toEqual([]);
  });

  it('createRow builds a valid row for every merchant-owned model in both modes', async () => {
    const m = await createMerchant();
    for (const model of MERCHANT_OWNED_MODELS) {
      for (const livemode of [false, true]) {
        const row = await createRow(model, m.id, livemode);
        expect(row.id, model).toMatch(/^[a-z]+_[0-9A-Z]{26}$/);
        expect(row.merchantId, model).toBe(m.id);
      }
    }
  });

  it('createApiKey stores a sha256 hash and a mode-specific prefix', async () => {
    const m = await createMerchant();
    const live = await createApiKey(m.id, { livemode: true });
    expect(live.raw.startsWith('tdr_live_')).toBe(true);
    expect(live.record.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(live.record.livemode).toBe(true);
    const pk = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    expect(pk.raw.startsWith('tdr_pk_test_')).toBe(true);
    expect(pk.record.kind).toBe('publishable');
  });

  it('resetDb clears events despite the append-only trigger', async () => {
    await insertEvent();
    await resetDb();
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM events`;
    expect(rows[0]?.n).toBe(0n);
  });
});
