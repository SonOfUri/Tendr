import { describe, expect, it } from 'vitest';
import { TENDR_DEFAULT_THEME, ThemeDocumentSchema, type ThemeDocument } from './index.js';

const valid = (): ThemeDocument => TENDR_DEFAULT_THEME('Kola Kicks');

function paths(doc: unknown): string[] {
  const r = ThemeDocumentSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}
function messages(doc: unknown): string[] {
  const r = ThemeDocumentSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('ThemeDocumentSchema', () => {
  it('accepts the default theme', () => {
    expect(ThemeDocumentSchema.safeParse(valid()).success).toBe(true);
  });

  it('requires exactly one payment block in blocks', () => {
    const none = { ...valid(), blocks: valid().blocks.filter((b) => b.type !== 'payment') };
    expect(messages(none).join()).toMatch(/exactly one payment/);
    const two = {
      ...valid(),
      blocks: [...valid().blocks, { id: 'pay2', type: 'payment' as const }],
    };
    expect(messages(two).join()).toMatch(/exactly one payment/);
  });

  it('rejects payment block nested or in success_blocks', () => {
    const inSuccess = {
      ...valid(),
      success_blocks: [...valid().success_blocks, { id: 'pay2', type: 'payment' }],
    };
    expect(paths(inSuccess)).toContain('success_blocks.2');
    const nested = {
      ...valid(),
      blocks: [
        { id: 'sec', type: 'section', blocks: [{ id: 'pay', type: 'payment' }] },
        { id: 'pay2', type: 'payment' },
      ],
    };
    expect(ThemeDocumentSchema.safeParse(nested).success).toBe(false);
  });

  it('rejects thank_you in blocks', () => {
    const d = { ...valid(), blocks: [...valid().blocks, { id: 'ty', type: 'thank_you' as const }] };
    expect(paths(d)).toContain('blocks.3');
  });

  it('rejects duplicate block ids', () => {
    const d = {
      ...valid(),
      blocks: [...valid().blocks, { id: 'summary', type: 'divider' as const }],
    };
    expect(messages(d).join()).toMatch(/used twice/);
  });

  it('rejects nesting deeper than 2 and over 40 blocks', () => {
    const deep = {
      ...valid(),
      blocks: [
        ...valid().blocks,
        {
          id: 'sec',
          type: 'section',
          blocks: [{ id: 'cols', type: 'columns', columns: [[], []] }],
        },
      ],
    };
    expect(ThemeDocumentSchema.safeParse(deep).success).toBe(false);
    const many = {
      ...valid(),
      blocks: [
        ...valid().blocks,
        ...Array.from({ length: 38 }, (_, i) => ({ id: `d${i}`, type: 'divider' as const })),
      ],
    };
    expect(messages(many).join()).toMatch(/at most 40/);
    const fits = { ...many, blocks: many.blocks.slice(0, 40) };
    expect(ThemeDocumentSchema.safeParse(fits).success).toBe(true);
  });

  it('rejects address in banner text, faq answer and display_name', () => {
    const addr = '0x' + 'ab12'.repeat(10);
    const base = valid();
    const banner = { ...base, blocks: [{ id: 'b', type: 'banner', text: addr }, ...base.blocks] };
    expect(paths(banner)).toContain('blocks.0.text');
    const faq = {
      ...base,
      blocks: [
        { id: 'f', type: 'faq', items: [{ q: 'Where?', a: `Send to ${addr}` }] },
        ...base.blocks,
      ],
    };
    expect(paths(faq)).toContain('blocks.0.items.0.a');
    const name = { ...base, settings: { ...base.settings, display_name: addr } };
    expect(paths(name)).toContain('settings.display_name');
  });

  it('rejects input-like props', () => {
    const d = {
      ...valid(),
      blocks: [{ id: 'x', type: 'divider', input: 'text' }, ...valid().blocks],
    };
    expect(ThemeDocumentSchema.safeParse(d).success).toBe(false);
    const unknownType = { ...valid(), blocks: [{ id: 'x', type: 'form' }, ...valid().blocks] };
    expect(ThemeDocumentSchema.safeParse(unknownType).success).toBe(false);
  });

  it('requires both palettes for auto mode', () => {
    const base = valid();
    const d = {
      ...base,
      settings: {
        ...base.settings,
        mode: 'auto',
        palettes: { light: base.settings.palettes.light },
      },
    };
    expect(paths(d)).toContain('settings.palettes.dark');
  });

  it('rejects button_label with amount', () => {
    const base = valid();
    const d = { ...base, settings: { ...base.settings, button_label: 'Pay $5' } };
    expect(paths(d)).toContain('settings.button_label');
  });

  it('countdown label cannot imitate the payment timer', () => {
    const base = valid();
    const d = {
      ...base,
      blocks: [
        {
          id: 'c',
          type: 'countdown',
          label: 'Session expires in',
          ends_at: '2030-01-01T00:00:00Z',
        },
        ...base.blocks,
      ],
    };
    expect(paths(d)).toContain('blocks.0.label');
  });

  it('rich_text refuses raw html and non-https links', () => {
    const base = valid();
    for (const markdown of ['<b>hi</b>', '[x](javascript:alert(1))', '![i](https://a.co/i.png)']) {
      const d = { ...base, blocks: [{ id: 'r', type: 'rich_text', markdown }, ...base.blocks] };
      expect(ThemeDocumentSchema.safeParse(d).success, markdown).toBe(false);
    }
    const ok = {
      ...base,
      blocks: [
        { id: 'r', type: 'rich_text', markdown: '**Hi** [site](https://a.co)\n\n- one\n- two' },
        ...base.blocks,
      ],
    };
    expect(ThemeDocumentSchema.safeParse(ok).success).toBe(true);
  });

  it('rich_text ignores base58-looking link targets but checks link text', () => {
    const base = valid();
    const b58 = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
    const doc = (markdown: string) => ({
      ...base,
      blocks: [{ id: 'r', type: 'rich_text', markdown }, ...base.blocks],
    });
    expect(ThemeDocumentSchema.safeParse(doc(`[shop](https://a.co/p/${b58})`)).success).toBe(true);
    expect(ThemeDocumentSchema.safeParse(doc(`[${b58}](https://a.co)`)).success).toBe(false);
  });

  it('trust_badges has no Tendr "verified merchant" badge', () => {
    const base = valid();
    const doc = (id: string) => ({
      ...base,
      blocks: [{ id: 'tb', type: 'trust_badges', badges: [{ kind: 'tendr', id }] }, ...base.blocks],
    });
    expect(ThemeDocumentSchema.safeParse(doc('secure-checkout')).success).toBe(true);
    expect(ThemeDocumentSchema.safeParse(doc('verified-merchant')).success).toBe(false);
  });

  it('enforces css size', () => {
    const d = { ...valid(), custom_css: 'a'.repeat(50 * 1024 + 1) };
    expect(ThemeDocumentSchema.safeParse(d).success).toBe(false);
  });
});
