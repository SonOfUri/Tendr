import { describe, expect, it } from 'vitest';
import { checkInlineStyle, scopeThemeCss } from './css.js';

const ORIGIN = 'https://assets.tendr.test';

function problemsOf(css: string): Array<{ line: number; message: string }> {
  const r = scopeThemeCss(css, ORIGIN);
  if (r.ok) throw new Error(`expected rejection for ${JSON.stringify(css)}, got ${r.css}`);
  return r.problems;
}

function expectRejected(css: string, reason: string): void {
  const problems = problemsOf(css);
  expect(
    problems.some((p) => p.message.includes(reason)),
    `${css} → ${problems.map((p) => p.message).join(' | ')}`,
  ).toBe(true);
  for (const p of problems) expect(p.line, css).toBeGreaterThanOrEqual(1);
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
    const cases: Array<[string, string]> = [
      ['body *{}', "`body` can't be styled"],
      [':root{}', "`:root` can't be styled"],
      ['.pay-card{}', '`.pay-card` is reserved'],
      ['.tdr-wrap{}', '`.tdr-wrap` is reserved'],
      [':host{}', "`:host` can't be styled"],
      ['h2:has(+ .x){}', "`:has()` isn't allowed"],
      ['a{position:fixed}', "`position: fixed` isn't allowed"],
      ['a{position: sticky}', "`position: sticky` isn't allowed"],
      ['@import url(x)', "`@import` isn't allowed"],
      ['@font-face{}', "`@font-face` isn't allowed"],
      ['a{background:url(https://evil.test/x.png)}', 'uploaded to Tendr'],
      ['a{background:url(data:image/png;base64,AA)}', 'uploaded to Tendr'],
      ['a{behavior:url(x)}', "`behavior` isn't allowed"],
    ];
    for (const [css, reason] of cases) expectRejected(css, reason);
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
    const cases: Array<[string, string]> = [
      ['html{}', "`html` can't be styled"],
      ['#tdr-root{}', '`#tdr-root` is reserved'],
      ['#PAY-x{}', '`#PAY-x` is reserved'],
      ['::part(x){}', "`::part` isn't allowed"],
      ['::slotted(p){}', "`::slotted` isn't allowed"],
      [':host-context(.x) p{}', "`:host-context` can't be styled"],
      [':scope{}', "`:scope` can't be styled"],
      ['p:is(body .x){}', "`body` can't be styled"],
      ['p:where(:root){}', "`:root` can't be styled"],
      ['p:not(.pay-card){}', '`.pay-card` is reserved'],
      ['a:-webkit-any(body){}', "`body` can't be styled"],
      ['\\62 ody{}', 'Escaped characters'],
      ['.x\\2d y{}', 'Escaped characters'],
      ['[class^="pay-"]{}', "Tendr's own class names"],
      ['[id*=tdr-]{}', "Tendr's own class names"],
      ['> p{}', "can't start with `>`"],
      ['+ .x{}', "can't start with `+`"],
      ['~ .x{}', "can't start with `~`"],
      ['*{}', '`*` on its own'],
      ['svg|a{}', 'Namespaced selectors'],
      ['a{ & b { color: red } }', 'Nested rules'],
      ['a{ .b { color: red } }', "couldn't be read"],
      ['@layer base { a{} }', "`@layer` isn't allowed"],
      ['@container (min-width: 1px) { a{} }', "`@container` isn't allowed"],
      ['@scope (.x) { a{} }', "`@scope` isn't allowed"],
      [
        '@property --tendr-bg { syntax: "<color>"; inherits: false; initial-value: red }',
        "`@property` isn't allowed",
      ],
      ['@namespace svg url(http://www.w3.org/2000/svg);', "`@namespace` isn't allowed"],
      ['@charset "utf-8";', "`@charset` isn't allowed"],
      ['@-webkit-keyframes x { from { opacity: 0 } }', "`@-webkit-keyframes` isn't allowed"],
      ['@keyframes "q" { from {} }', '`@keyframes` needs a plain name'],
      ['@keyframes k { body { color: red } }', 'Keyframes can only use'],
      ['a{position:-webkit-sticky}', "`position: sticky` isn't allowed"],
      ['a{position:var(--p)}', "`position` can't use `var()`"],
      ['a{position:\\66ixed}', 'Escaped characters'],
      ['a{-moz-binding:url(https://assets.tendr.test/x.xml)}', "`-moz-binding` isn't allowed"],
      ['a{-ms-behavior:url(x)}', "`behavior` isn't allowed"],
      ['a{width:expression(alert(1))}', "`expression()` isn't allowed"],
      ['a{background:image-set("https://evil.test/x.png" 1x)}', "`image-set()` isn't allowed"],
      [
        'a{background:-webkit-image-set(url(https://evil.test/x.png) 1x)}',
        "`image-set()` isn't allowed",
      ],
      ['a{background:src("https://assets.tendr.test/x.png")}', "`src()` isn't allowed"],
      ['a{background:-moz-element(#pay)}', "`element()` isn't allowed"],
      ['a{background:url(/x.png)}', 'uploaded to Tendr'],
      ['a{background:url(//evil.test/x.png)}', 'uploaded to Tendr'],
      ['a{background:url(http://assets.tendr.test/x.png)}', 'uploaded to Tendr'],
      ['a{clip-path:url(#pay)}', 'uploaded to Tendr'],
      ['a{--bg:url(https://evil.test/x.png)}', 'uploaded to Tendr'],
      ['@supports (background: url(https://evil.test/x)) { a{} }', 'uploaded to Tendr'],
      ['a{-webkit-user-modify:read-write}', "`user-modify` isn't allowed"],
      ['a{view-transition-name:hero}', "`view-transition-name` isn't allowed"],
      ['a{anchor-name:--x}', 'Anchor positioning'],
      ['a{position-anchor:--pay}', 'Anchor positioning'],
      ['a{top:anchor(--pay bottom)}', "`anchor()` isn't allowed"],
      ['p::before{content:"Send USDC to this wallet address"}', 'wallet addresses'],
      ['p::before{content:"0x52908400098527886E0F7030069857D2E4169EE7"}', 'wallet addresses'],
      ['p::before{content:"\\30 x52908400098527886E0F7030069857D2E4169EE7"}', 'wallet addresses'],
      ['a{font-family:"0x52908400098527886E0F7030069857D2E4169EE7"}', 'wallet addresses'],
      ['a{color:red;{', "couldn't be read"],
      ['a{}}', "couldn't be read"],
    ];
    for (const [css, reason] of cases) expectRejected(css, reason);
  });

  it('never emits sequences that end a <style> element', () => {
    const hostile = [
      'p{content:"</style><script>alert(1)</script>"}',
      'p{content:"\\3c /style>"}',
      'p{content:"<!--"}',
      'p{font-family:"</style>"}',
      'p{font-family:"\\3c !--"}',
      '[title="</style>"] p{color:red}',
      '[title="\\3c !--"] p{color:red}',
      '@supports (content: "</style>") { p{color:red} }',
      'p{background:url("https://assets.tendr.test/</style>")}',
      'p{background:url(https://assets.tendr.test/\\3c /style>)}',
      'p{--x:"</style>"}',
      'p{color:red}/* </style><script>alert(1)</script> */',
      '<!-- p{color:red} -->',
      '</style><script>alert(1)</script>',
      '</STYLE ><p>x',
    ];
    for (const css of hostile) {
      const r = scopeThemeCss(css, ORIGIN);
      if (r.ok) expect(r.css, css).not.toMatch(/<\/style|<!--/i);
    }
    const ANGLE = "CSS text and links can't contain `<`";
    for (const css of [
      'p{content:"</style><script>alert(1)</script>"}',
      'p{content:"\\3c /style>"}',
      'p{font-family:"</style>"}',
      '[title="</style>"] p{color:red}',
      'p{background:url("https://assets.tendr.test/</style>")}',
    ]) {
      expectRejected(css, ANGLE);
    }
  });

  it('rejects attr() so CSS cannot copy text onto the page', () => {
    expectRejected('p::after{content:attr(class)}', "`attr()` isn't allowed");
    expectRejected('p{width:attr(data-w px)}', "`attr()` isn't allowed");
  });

  it('keeps displayed CSS strings icon-sized', () => {
    expectRejected('p::before{content:"Send!"}', 'at most 4 characters');
    expectRejected('p::before{content:"0x5290" "8400"}', 'at most 4 characters');
    expectRejected('li{list-style-type:"Pay here "}', 'at most 4 characters');
    expectRejected('p{text-overflow:"click me"}', 'at most 4 characters');
    expectRejected('q{quotes:"«««««" "»"}', 'at most 4 characters');
    const ok = scopeThemeCss(
      'q::before{content:"“"} li::marker{content:"★ "} .x::after{content:"→"}',
      ORIGIN,
    );
    expect(ok.ok).toBe(true);
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
