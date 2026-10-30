import { describe, expect, it } from 'vitest';
import {
  LINK_SLUG_RE,
  PaymentLinkCreateSchema,
  PaymentLinkUpdateSchema,
  RESERVED_LINK_SLUGS,
  cleanPayerNote,
} from './index.js';

const base = { title: 'Tithe', currency: 'USD' };

describe('PaymentLinkCreateSchema', () => {
  it('rejects fixed links without amount and open links with amount', () => {
    expect(PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'fixed' }).success).toBe(false);
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'fixed', amount: '10.00' }).success,
    ).toBe(true);
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', amount: '10.00' }).success,
    ).toBe(false);
    expect(PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open' }).success).toBe(true);
  });

  it('rejects min_amount on fixed links', () => {
    const r = PaymentLinkCreateSchema.safeParse({
      ...base,
      amount_type: 'fixed',
      amount: '10',
      min_amount: '5',
    });
    expect(r.success).toBe(false);
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', min_amount: '5' }).success,
    ).toBe(true);
  });

  it('defaults note to optional', () => {
    const r = PaymentLinkCreateSchema.parse({ ...base, amount_type: 'open' });
    expect(r.note).toBe('optional');
  });

  it('slug rule', () => {
    const ok = (slug: string) =>
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', slug }).success;
    for (const bad of ['ab', '-ab', 'ab-', 'Ab1', 'a'.repeat(61)]) expect(ok(bad), bad).toBe(false);
    for (const good of ['tithe', 'sunday-offering-2', 'a'.repeat(60)]) expect(ok(good), good).toBe(true);
    expect(LINK_SLUG_RE.test('tithe')).toBe(true);
    for (const r of RESERVED_LINK_SLUGS) expect(ok(r), r).toBe(false);
  });
});

describe('PaymentLinkUpdateSchema', () => {
  it('has no slug, all fields optional, and accepts archived', () => {
    expect(PaymentLinkUpdateSchema.safeParse({}).success).toBe(true);
    expect(PaymentLinkUpdateSchema.safeParse({ archived: true }).success).toBe(true);
    expect(PaymentLinkUpdateSchema.parse({ slug: 'x-y-z', title: 'T' })).toEqual({ title: 'T' });
  });
});

describe('cleanPayerNote', () => {
  it('strips control characters, collapses whitespace and trims', () => {
    expect(cleanPayerNote('  hi\u0000\u0007 there  ')).toBe('hi there');
  });
  it('returns null when empty', () => {
    expect(cleanPayerNote('\n\t')).toBeNull();
    expect(cleanPayerNote(undefined)).toBeNull();
  });
  it('truncates to 280 code points', () => {
    expect(cleanPayerNote('a'.repeat(300))).toHaveLength(280);
  });
  it('leaves markup alone (escaping happens at render)', () => {
    expect(cleanPayerNote('<b>x</b>')).toBe('<b>x</b>');
  });
  it('never splits a surrogate pair at the cut', () => {
    const out = cleanPayerNote('a'.repeat(279) + '😀😀')!;
    expect(Array.from(out)).toHaveLength(280);
    expect(out.endsWith('😀')).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff]$/);
  });
});
