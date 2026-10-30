// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENDR_DEFAULT_THEME, type ShopperTheme, type ThemeBlock } from '@tendr/contracts';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeVars } from '@/lib/theme/vars';
import { BlockCanvas } from './BlockCanvas';
import { ThemeStyles } from './ThemeStyles';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function theme(patch: Partial<ShopperTheme> = {}): ShopperTheme {
  return {
    id: 'thm_1',
    version: 1,
    document: TENDR_DEFAULT_THEME('Kola Kicks'),
    rendered: {},
    assets: {},
    css: null,
    payee: 'Lagos Leather Co.',
    trading_as: 'Kola Kicks',
    ...patch,
  };
}

const PAYMENT = (
  <div>
    <h2>Pay with crypto</h2>
    <span className="pay-amount">25.10 USDC</span>
    <button type="button" className="pay-button">
      <span className="pay-button-label">Pay</span>
    </button>
  </div>
);

function blocksOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll(':scope > .tdr-canvas > *')].map(
    (el) => el.querySelector('[data-block]')?.getAttribute('data-block') ?? el.className,
  );
}

describe('BlockCanvas', () => {
  it('renders blocks in order and skips hidden', () => {
    const blocks: ThemeBlock[] = [
      { id: 'intro', type: 'heading', text: 'Handmade in Lagos', level: 2 },
      { id: 'gone', type: 'heading', text: 'Hidden', level: 3, hidden: true },
      { id: 'payment', type: 'payment' },
      { id: 'line', type: 'divider' },
      { id: 'note', type: 'delivery_note', text: 'Ships in 2 days' },
    ];
    const { container, queryByText } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    expect(blocksOf(container)).toEqual(['intro', 'tdr-payment', 'line', 'note']);
    expect(queryByText('Hidden')).toBeNull();
    const intro = container.querySelector('[data-block="intro"]');
    expect(intro?.closest('.tdr-scope')?.parentElement?.className).toBe('tdr-wrap');
    expect(intro?.closest('.tdr-wrap')?.getAttribute('data-type')).toBe('heading');
  });

  it('payment slot is outside every tdr-scope', () => {
    const blocks: ThemeBlock[] = [
      {
        id: 'cols',
        type: 'columns',
        columns: [[{ id: 'a', type: 'heading', text: 'Left', level: 3 }], []],
      },
      { id: 'payment', type: 'payment' },
      { id: 'sec', type: 'section', blocks: [{ id: 'b', type: 'divider' }] },
    ];
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    const sealed = container.querySelectorAll('section.tdr-payment[data-sealed]');
    expect(sealed).toHaveLength(1);
    const amount = container.querySelector('.pay-amount');
    expect(amount?.closest('.tdr-payment')).toBe(sealed[0]);
    expect(amount?.closest('.tdr-scope, .tdr-wrap, .tdr-content')).toBeNull();
    // Nested blocks stay inside their parent's contained wrapper.
    const nested = container.querySelector('[data-block="a"]');
    expect(nested?.closest('[data-block="cols"]')).not.toBeNull();
  });

  it('asset font never applies inside sealed block', () => {
    const doc = TENDR_DEFAULT_THEME('Kola Kicks');
    const t = theme({
      document: { ...doc, settings: { ...doc.settings, font: { kind: 'asset', asset_id: 'fnt' } } },
      assets: { fnt: { url: 'https://assets.example/f.woff2', kind: 'font', mime: 'font/woff2' } },
    });
    const vars = themeVars(t, 'dark');
    expect(vars['--theme-font']).toContain('tdr-brand-font');
    expect(vars).not.toHaveProperty('--theme-font-curated');

    const { container } = render(
      <BlockCanvas
        blocks={[{ id: 'payment', type: 'payment' }]}
        theme={t}
        slots={{ payment: PAYMENT }}
      />,
    );
    const amount = container.querySelector('.pay-amount');
    // `--theme-font` is applied only on `.tdr-wrap` (merchant blocks); the amount has no such ancestor.
    expect(amount?.closest('.tdr-wrap, .tdr-scope, .tdr-content')).toBeNull();
    expect(amount?.closest('.tdr-payment')).not.toBeNull();

    // The stylesheet contract: inside `.tdr-payment` only `--theme-font-curated` is ever used.
    const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const sealedRules = rules.filter(([, sel]) => sel?.includes('.tdr-payment'));
    expect(sealedRules.length).toBeGreaterThan(0);
    for (const [, sel, body] of sealedRules) {
      expect(body, sel).not.toMatch(/var\(--theme-font\)|var\(--theme-font,/);
    }
    const wrapRule = rules.find(([, sel]) => sel?.trim() === '.tdr-wrap');
    expect(wrapRule?.[2]).toMatch(/contain:\s*layout paint/);
    expect(wrapRule?.[2]).toMatch(/overflow:\s*clip/);
    expect(wrapRule?.[2]).toMatch(/isolation:\s*isolate/);
    // Tendr never uses the prefix reserved for merchant keyframes.
    expect(css).not.toMatch(/tdrm-/);
  });

  it('unknown block type renders nothing', () => {
    const blocks = [
      { id: 'mystery', type: 'hologram' },
      { id: 'payment', type: 'payment' },
    ] as unknown as ThemeBlock[];
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    expect(container.querySelector('[data-block="mystery"]')).toBeNull();
    expect(container.querySelector('[data-type="hologram"]')).toBeNull();
    expect(blocksOf(container)).toEqual(['tdr-payment']);
  });

  it('draws the payment slot even when the list has no payment block', () => {
    const blocks: ThemeBlock[] = [{ id: 'intro', type: 'heading', text: 'Hi', level: 2 }];
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    expect(blocksOf(container)).toEqual(['intro', 'tdr-payment']);
    cleanup();
    const success = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: null }} />,
    );
    expect(success.container.querySelector('.tdr-payment')).toBeNull();
  });

  it('renders only server-rendered rich text and never raw markdown', () => {
    const blocks: ThemeBlock[] = [
      { id: 'story', type: 'rich_text', markdown: '**raw markdown**' },
      { id: 'empty', type: 'rich_text', markdown: 'never rendered' },
      { id: 'payment', type: 'payment' },
    ];
    const { container, queryByText } = render(
      <BlockCanvas
        blocks={blocks}
        theme={theme({ rendered: { story: '<p><strong>Made by hand</strong></p>' } })}
        slots={{ payment: PAYMENT }}
      />,
    );
    expect(container.querySelector('[data-block="story"] strong')?.textContent).toBe(
      'Made by hand',
    );
    expect(queryByText(/raw markdown|never rendered/)).toBeNull();
    expect(container.querySelector('[data-block="empty"]')).toBeNull();
  });

  it('skips images whose asset was deleted', () => {
    const blocks: ThemeBlock[] = [
      { id: 'pic', type: 'image', asset_id: 'gone', alt: 'Bag' },
      { id: 'top', type: 'header', show_logo: true, show_name: false },
      {
        id: 'badges',
        type: 'trust_badges',
        badges: [{ kind: 'asset', asset_id: 'gone', alt: 'x' }],
      },
      { id: 'payment', type: 'payment' },
    ];
    const doc = TENDR_DEFAULT_THEME('Kola Kicks');
    const t = theme({ document: { ...doc, settings: { ...doc.settings, logo_asset_id: 'gone' } } });
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={t} slots={{ payment: PAYMENT }} />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('embeds videos through privacy-enhanced hosts in a sandbox', () => {
    const blocks: ThemeBlock[] = [
      { id: 'yt', type: 'video', provider: 'youtube', video_id: 'dQw4w9WgXcQ' },
      { id: 'vm', type: 'video', provider: 'vimeo', video_id: '76979871' },
      { id: 'payment', type: 'payment' },
    ];
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    const frames = [...container.querySelectorAll('iframe')];
    expect(frames.map((f) => f.getAttribute('src'))).toEqual([
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://player.vimeo.com/video/76979871?dnt=1',
    ]);
    for (const f of frames) {
      expect(f.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-presentation');
      expect(f.getAttribute('loading')).toBe('lazy');
    }
  });

  it('countdown ticks and shows Ended after ends_at', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const blocks: ThemeBlock[] = [
      { id: 'sale', type: 'countdown', label: 'Sale ends', ends_at: '2026-11-01T00:00:03Z' },
      { id: 'payment', type: 'payment' },
    ];
    const { container } = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    const value = () =>
      container.querySelector('[data-block="sale"] .tdr-countdown-value')?.textContent;
    expect(value()).toBe('0:00:03');
    act(() => vi.advanceTimersByTime(1000));
    expect(value()).toBe('0:00:02');
    act(() => vi.advanceTimersByTime(3000));
    expect(value()).toBe('Ended');
  });

  it('renders the order summary slot only when given', () => {
    const blocks: ThemeBlock[] = [
      { id: 'summary', type: 'order_summary' },
      { id: 'payment', type: 'payment' },
    ];
    const without = render(
      <BlockCanvas blocks={blocks} theme={theme()} slots={{ payment: PAYMENT }} />,
    );
    expect(without.container.querySelector('[data-block="summary"]')).toBeNull();
    cleanup();
    const withSummary = render(
      <BlockCanvas
        blocks={blocks}
        theme={theme()}
        slots={{ payment: PAYMENT, orderSummary: <p>2 × Tote bag</p> }}
      />,
    );
    expect(withSummary.getByText('2 × Tote bag').closest('[data-block="summary"]')).not.toBeNull();
  });
});

describe('ThemeStyles', () => {
  it('loads curated fonts from /fonts and injects only the scoped css', () => {
    const doc = TENDR_DEFAULT_THEME('Kola Kicks');
    const t = theme({
      document: {
        ...doc,
        settings: { ...doc.settings, font: { kind: 'curated', id: 'lora' } },
        custom_css: 'body { display: none }',
      },
      css: '.tdr-scope p{color:#c00}',
    });
    const { container } = render(<ThemeStyles theme={t} scheme="dark" />);
    const text = [...container.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(text).toContain('url("/fonts/lora.woff2")');
    expect(text).toContain('font-family: "Lora"');
    expect(text).toContain('.tdr-scope p{color:#c00}');
    expect(text).not.toContain('display: none');
  });

  it('loads an uploaded font from its asset url', () => {
    const doc = TENDR_DEFAULT_THEME('Kola Kicks');
    const t = theme({
      document: { ...doc, settings: { ...doc.settings, font: { kind: 'asset', asset_id: 'fnt' } } },
      assets: { fnt: { url: 'https://assets.example/f.woff2', kind: 'font', mime: 'font/woff2' } },
    });
    const { container } = render(<ThemeStyles theme={t} scheme="dark" />);
    const text = container.querySelector('style')?.textContent ?? '';
    expect(text).toContain('font-family: "tdr-brand-font"');
    expect(text).toContain('url("https://assets.example/f.woff2")');
  });
});
