import { describe, expect, it } from 'vitest';
import {
  LINK_SLUG_RE,
  PaymentLinkCreateSchema,
  PaymentLinkUpdateSchema,
  RESERVED_LINK_SLUGS,
  cleanPayerNote,
} from './index.js';

const base = { title: 'Tithe', currency: 'USD' };

describe('reserved link slugs on the pay host root', () => {
  it.each([
    'pay',
    'preview',
    'v1',
    'downloads',
    'privacy',
    'terms',
    'api',
    'demo',
    'dashboard',
    'connect',
    'login',
    'signup',
    'verify',
    'invite',
    'recover',
    'settings',
    'icons',
    'fonts',
  ])('refuses %s as a link slug', (slug) => {
    expect(RESERVED_LINK_SLUGS).toContain(slug);
    expect(PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', slug }).success).toBe(
      false,
    );
  });
});

describe('PaymentLinkCreateSchema', () => {
  it('rejects fixed links without amount and open links with amount', () => {
    expect(PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'fixed' }).success).toBe(
      false,
    );
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
    for (const good of ['tithe', 'sunday-offering-2', 'a'.repeat(60)])
      expect(ok(good), good).toBe(true);
    expect(LINK_SLUG_RE.test('tithe')).toBe(true);
    for (const r of RESERVED_LINK_SLUGS) expect(ok(r), r).toBe(false);
    for (const r of [
      'refund-address',
      'qr',
      'opengraph-image',
      'twitter-image',
      'test',
      'new',
      'edit',
    ]) {
      expect(RESERVED_LINK_SLUGS, r).toContain(r);
      expect(ok(r), r).toBe(false);
    }
  });
});

describe('PaymentLinkUpdateSchema', () => {
  it('refuses slug, all fields optional, and accepts archived', () => {
    expect(PaymentLinkUpdateSchema.safeParse({}).success).toBe(true);
    expect(PaymentLinkUpdateSchema.safeParse({ archived: true }).success).toBe(true);
    expect(PaymentLinkUpdateSchema.safeParse({ slug: 'x-y-z', title: 'T' }).success).toBe(false);
  });
});

describe('cleanPayerNote', () => {
  it('strips control characters, collapses whitespace and trims', () => {
    expect(cleanPayerNote('  hi\u0000\u0007 there  ')).toBe('hi there');
  });
  it('removes bidi and direction controls, keeping the emoji joiner', () => {
    const controls = ['‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '؜'];
    for (const c of controls) expect(cleanPayerNote(`pay${c}ment`)).toBe('payment');
    // A right-to-left override cannot flip how the note reads in the dashboard or the email.
    expect(cleanPayerNote('invoice ‮fdp.exe‬ ok')).toBe('invoice fdp.exe ok');
    const family = '👨‍👩‍👧';
    expect(cleanPayerNote(`for the ${family}`)).toBe(`for the ${family}`);
    expect(cleanPayerNote('‮⁦')).toBeNull();
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

describe('null clears optional fields (update only)', () => {
  const clearable = [
    'expires_at',
    'max_uses',
    'description',
    'min_amount',
    'fee_payer',
    'gas_payer',
    'gas_max_usd',
  ];
  it('update accepts null on each clearable field', () => {
    for (const f of clearable) {
      expect(PaymentLinkUpdateSchema.safeParse({ [f]: null }).success, f).toBe(true);
    }
  });
  it('create rejects null on each clearable field', () => {
    for (const f of clearable) {
      const r = PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', [f]: null });
      expect(r.success, f).toBe(false);
    }
  });
  it('omitted stays undefined', () => {
    expect(PaymentLinkUpdateSchema.parse({ title: 'x' }).expires_at).toBeUndefined();
  });
});

describe('strict bodies', () => {
  it('rejects unknown keys, including slug on update', () => {
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', bogus: 1 }).success,
    ).toBe(false);
    expect(PaymentLinkUpdateSchema.safeParse({ slug: 'new-slug' }).success).toBe(false);
    expect(PaymentLinkUpdateSchema.safeParse({ title: 'ok' }).success).toBe(true);
  });
});

describe('link text', () => {
  it('link title with an address is rejected', () => {
    const addr = '0x' + 'ab12'.repeat(10);
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', title: addr }).success,
    ).toBe(false);
    expect(
      PaymentLinkCreateSchema.safeParse({
        ...base,
        amount_type: 'open',
        description: 'Please send USDC to this wallet',
      }).success,
    ).toBe(false);
    expect(PaymentLinkUpdateSchema.safeParse({ title: addr }).success).toBe(false);
  });
  it('accepts theme_id including null', () => {
    expect(
      PaymentLinkCreateSchema.safeParse({ ...base, amount_type: 'open', theme_id: 'th_1' }).success,
    ).toBe(true);
    expect(PaymentLinkUpdateSchema.safeParse({ theme_id: null }).success).toBe(true);
  });
});
