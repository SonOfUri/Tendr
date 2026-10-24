import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import { prisma } from './prisma.js';
import { toJsonDecimal } from './serialize.js';

describe('toJsonDecimal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('10^30 smallest units round-trip exactly as a string', async () => {
    const m = await createMerchant();
    const q = await createRow('Quote', m.id, false, {
      amountIn: new Prisma.Decimal('1000000000000000000000000000000'),
    });
    const back = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(toJsonDecimal(back.amountIn)).toBe('1000000000000000000000000000000');
  });

  it('keeps every fractional digit and never uses exponent notation', () => {
    expect(toJsonDecimal(new Prisma.Decimal('49.000000000000000001'))).toBe(
      '49.000000000000000001',
    );
    expect(toJsonDecimal(new Prisma.Decimal('1e-18'))).toBe('0.000000000000000001');
    expect(toJsonDecimal(new Prisma.Decimal('1e40'))).toBe(`1${'0'.repeat(40)}`);
  });

  it('passes null through', () => {
    expect(toJsonDecimal(null)).toBeNull();
  });
});
