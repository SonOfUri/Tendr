import { describe, expect, it } from 'vitest';
import { checkInlineStyle, scopeThemeCss } from './css.js';

const ORIGIN = 'https://assets.tendr.test';

function problemsOf(css: string): Array<{ line: number; message: string }> {
  const r = scopeThemeCss(css, ORIGIN);
  if (r.ok) throw new Error(`expected rejection for ${JSON.stringify(css)}, got ${r.css}`);
  return r.problems;
}

describe('scopeThemeCss', () => {
  it('scopes simple selectors', () => {
    const r = scopeThemeCss('h2{color:red}\n.title, p > em { font-weight: 700 }', ORIGIN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toContain('.tdr-scope h2');
    expect(r.css).toContain('.tdr-scope .title');
    expect(r.css).toContain('.tdr-scope p>em');
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scopes selectors inside @media and @supports', () => {
    const r = scopeThemeCss(
      '@media (max-width: 600px) { h3 { margin: 0 } }\n@supports (display: grid) { .grid { display: grid } }',
      ORIGIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toContain('@media (max-width:600px){.tdr-scope h3{');
    expect(r.css).toContain('{.tdr-scope .grid{');
  });

  it('css rejects escapes', () => {
    const cases = [
      'body *{}',
      ':root{}',
      '.pay-card{}',
      '.tdr-wrap{}',
      ':host{}',
      'h2:has(+ .x){}',
      'a{position:fixed}',
      'a{position: sticky}',
      '@import url(x)',
      '@font-face{}',
      'a{background:url(https://evil.test/x.png)}',
      'a{background:url(data:image/png;base64,AA)}',
      'a{behavior:url(x)}',
    ];
    for (const css of cases) {
      const problems = problemsOf(css);
      expect(problems.length, css).toBeGreaterThan(0);
      for (const p of problems) {
        expect(p.line, css).toBeGreaterThanOrEqual(1);
        expect(p.message, css).not.toEqual('');
      }
    }
  });

  it('reports the line of the offending rule with a plain reason', () => {
    const problems = problemsOf('h2 { color: red }\n\np {\n  position: fixed;\n}');
    expect(problems).toEqual([
      {
        line: 4,
        message: "`position: fixed` isn't allowed — it could cover the payment details",
      },
    ]);
  });

  it('rejects the extra escape routes', () => {
    const cases = [
      'html{}',
      '#tdr-root{}',
      '#PAY-x{}',
      '::part(x){}',
      '::slotted(p){}',
      ':host-context(.x) p{}',
      ':scope{}',
      'p:is(body .x){}',
      'p:where(:root){}',
      'p:not(.pay-card){}',
      'a:-webkit-any(body){}',
      '\\62 ody{}',
      '.x\\2d y{}',
      '[class^="pay-"]{}',
      '[id*=tdr-]{}',
      '> p{}',
      '+ .x{}',
      '~ .x{}',
      '*{}',
      'svg|a{}',
      'a{ & b { color: red } }',
      'a{ .b { color: red } }',
      '@layer base { a{} }',
      '@container (min-width: 1px) { a{} }',
      '@scope (.x) { a{} }',
      '@property --tendr-bg { syntax: "<color>"; inherits: false; initial-value: red }',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@charset "utf-8";',
      '@-webkit-keyframes x { from { opacity: 0 } }',
      'a{position:-webkit-sticky}',
      'a{position:var(--p)}',
      'a{position:\\66ixed}',
      'a{-moz-binding:url(https://assets.tendr.test/x.xml)}',
      'a{-ms-behavior:url(x)}',
      'a{width:expression(alert(1))}',
      'a{background:image-set("https://evil.test/x.png" 1x)}',
      'a{background:-webkit-image-set(url(https://evil.test/x.png) 1x)}',
      'a{background:src("https://assets.tendr.test/x.png")}',
      'a{background:-moz-element(#pay)}',
      'a{background:url(/x.png)}',
      'a{background:url(//evil.test/x.png)}',
      'a{background:url(http://assets.tendr.test/x.png)}',
      'a{clip-path:url(#pay)}',
      'a{--bg:url(https://evil.test/x.png)}',
      'a{-webkit-user-modify:read-write}',
      'a{view-transition-name:hero}',
      'a{anchor-name:--x}',
      'a{position-anchor:--pay}',
      'a{top:anchor(--pay bottom)}',
      'p::before{content:"Send USDC to this wallet address"}',
      'p::before{content:"0x52908400098527886E0F7030069857D2E4169EE7"}',
      'p::before{content:"\\30 x52908400098527886E0F7030069857D2E4169EE7"}',
      'a{color:red;{',
      'a{}}',
    ];
    for (const css of cases) {
      const problems = problemsOf(css);
      expect(problems.length, css).toBeGreaterThan(0);
      for (const p of problems) expect(p.line, css).toBeGreaterThanOrEqual(1);
    }
  });

  it('allows asset-origin urls and keyframes', () => {
    const r = scopeThemeCss(
      [
        '.hero { background: url("https://assets.tendr.test/a/hero.png") center/cover; }',
        '@keyframes float { from { transform: translateY(0) } 50% { transform: translateY(-4px) } to { transform: none } }',
        '.badge { animation: float 2s ease-in-out infinite; }',
        '.dot { animation-name: float; }',
      ].join('\n'),
      ORIGIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toContain('url(https://assets.tendr.test/a/hero.png)');
    // Keyframe names are renamed so they can never replace Tendr's own animations.
    expect(r.css).toContain('@keyframes tdrm-float{from{');
    expect(r.css).toContain('50%{');
    expect(r.css).toContain('.tdr-scope .badge{animation:tdrm-float 2s ease-in-out infinite}');
    expect(r.css).toContain('.tdr-scope .dot{animation-name:tdrm-float}');
    expect(r.css).not.toContain('.tdr-scope from');
  });

  it('rejects over 50 KB', () => {
    const css = `p{color:red}\n${'/* padding */\n'.repeat(4000)}`;
    expect(new TextEncoder().encode(css).length).toBeGreaterThan(50 * 1024);
    const problems = problemsOf(css);
    expect(problems).toEqual([{ line: 1, message: 'CSS is over 50 KB' }]);
  });

  it('negative margins are allowed but stay inside the scope', () => {
    const r = scopeThemeCss(
      '.banner { margin-top: -400px; z-index: 99999; transform: translateY(-50%) }',
      ORIGIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.css).toBe(
      '.tdr-scope .banner{margin-top:-400px;z-index:99999;transform:translateY(-50%)}',
    );
  });

  it('every rewritten selector starts with the scope', () => {
    const r = scopeThemeCss(
      'a, p:not(.x) span, h2::after, [data-block=faq] li { color: red }',
      ORIGIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const selectors = r.css.slice(0, r.css.indexOf('{')).split(',');
    expect(selectors).toHaveLength(4);
    for (const s of selectors) expect(s.startsWith('.tdr-scope ')).toBe(true);
  });

  it('empty css is fine', () => {
    const r = scopeThemeCss('  /* nothing */ ', ORIGIN);
    expect(r).toMatchObject({ ok: true, css: '' });
  });
});

describe('checkInlineStyle', () => {
  it('keeps safe declarations', () => {
    expect(checkInlineStyle('color: red; margin: 0 auto', ORIGIN)).toEqual({
      ok: true,
      style: 'color:red;margin:0 auto',
    });
  });

  it('applies the same property rules', () => {
    for (const style of [
      'position: fixed',
      'background: url(https://evil.test/x.png)',
      'behavior: url(x)',
      'width: expression(1)',
    ]) {
      const r = checkInlineStyle(style, ORIGIN);
      expect(r.ok, style).toBe(false);
    }
  });
});
