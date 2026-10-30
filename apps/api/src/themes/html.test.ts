import { describe, expect, it } from 'vitest';
import { sanitizeThemeHtml } from './html.js';

const ORIGIN = 'https://assets.tendr.test';

function problemsOf(html: string): string[] {
  const r = sanitizeThemeHtml(html, ORIGIN);
  if (r.ok) throw new Error(`expected rejection for ${JSON.stringify(html)}, got ${r.html}`);
  return r.problems;
}

describe('sanitizeThemeHtml', () => {
  it('html strips forms and scripts', () => {
    const cases: Array<[string, RegExp]> = [
      ['<script>alert(1)</script>', /<script>/],
      ['<p>Hi<SCRIPT src="https://evil.test/x.js"></SCRIPT></p>', /<script>/],
      ['<form action="https://evil.test"><p>x</p></form>', /<form>/],
      ['<input name="card">', /<input>/],
      ['<button>Pay</button>', /<button>/],
      ['<select><option>a</option></select>', /<select>/],
      ['<textarea>seed phrase</textarea>', /<textarea>/],
      ['<iframe src="https://evil.test"></iframe>', /<iframe>/],
      ['<object data="x"></object>', /<object>/],
      ['<embed src="x">', /<embed>/],
      ['<svg><circle r="4"/></svg>', /<svg>/],
      ['<style>body{display:none}</style>', /<style>/],
      ['<link rel="stylesheet" href="https://evil.test/x.css">', /<link>/],
      ['<meta http-equiv="refresh" content="0;url=https://evil.test">', /<meta>/],
      ['<base href="https://evil.test/">', /<base>/],
      ['<img src="https://assets.tendr.test/x.png" onerror="alert(1)">', /onerror/],
      ['<p onclick="steal()">hi</p>', /onclick/],
      ['<a href="javascript:alert(1)">x</a>', /javascript:/],
      ['<a href=" JaVa&#x09;ScRiPt:alert(1)">x</a>', /javascript:/],
      ['<p contenteditable="true">type here</p>', /contenteditable/],
      ['<template><p>x</p></template>', /<template>/],
      ['<math><mi>x</mi></math>', /<math>/],
    ];
    for (const [html, reason] of cases) {
      const problems = problemsOf(html);
      expect(
        problems.some((p) => reason.test(p)),
        `${html} → ${problems.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('keeps allowed formatting', () => {
    const html =
      '<h2 class="title">Our story</h2><p>We make <strong>soft</strong> <em>socks</em>, <b>b</b> <i>i</i> <u>u</u> <s>s</s> <small>small</small><br></p>' +
      '<ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Quote</blockquote><hr>' +
      '<figure><img src="https://assets.tendr.test/m/sock.png" alt="A sock"><figcaption>Sock</figcaption></figure>' +
      '<table><thead><tr><th>Size</th></tr></thead><tbody><tr><td>M</td></tr></tbody></table>' +
      '<div style="color: #333; padding: 4px"><span>ok</span></div><h3>h3</h3><h4>h4</h4>';
    const r = sanitizeThemeHtml(html, ORIGIN);
    expect(r).toEqual({
      ok: true,
      html:
        '<h2 class="title">Our story</h2><p>We make <strong>soft</strong> <em>socks</em>, <b>b</b> <i>i</i> <u>u</u> <s>s</s> <small>small</small><br /></p>' +
        '<ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Quote</blockquote><hr />' +
        '<figure><img src="https://assets.tendr.test/m/sock.png" alt="A sock" /><figcaption>Sock</figcaption></figure>' +
        '<table><thead><tr><th>Size</th></tr></thead><tbody><tr><td>M</td></tr></tbody></table>' +
        '<div style="color:#333;padding:4px"><span>ok</span></div><h3>h3</h3><h4>h4</h4>',
    });
  });

  it('strips tags and attributes that are not on the list', () => {
    const r = sanitizeThemeHtml(
      '<h1 id="x" data-x="1" title="t">Big</h1><video src="https://assets.tendr.test/v.mp4"></video><details><summary>More</summary>Text</details>',
      ORIGIN,
    );
    expect(r).toEqual({ ok: true, html: 'BigMoreText' });
  });

  it('forces rel and target on links', () => {
    const r = sanitizeThemeHtml(
      '<a href="https://shop.example/about" target="_self" rel="opener">About</a>',
      ORIGIN,
    );
    expect(r).toEqual({
      ok: true,
      html: '<a href="https://shop.example/about" target="_blank" rel="noopener noreferrer">About</a>',
    });
  });

  it('rejects links that are not https', () => {
    for (const html of [
      '<a href="http://shop.example">x</a>',
      '<a href="/about">x</a>',
      '<a href="mailto:a@b.c">x</a>',
      '<a href="data:text/html,hi">x</a>',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/https:\/\//);
    }
  });

  it('rejects images outside asset origin', () => {
    for (const html of [
      '<img src="https://evil.test/qr.png" alt="QR">',
      '<img src="//evil.test/qr.png">',
      '<img src="/qr.png">',
      '<img src="data:image/png;base64,AA">',
      '<img src="https://assets.tendr.test.evil.test/x.png">',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/Images/);
    }
  });

  it('rejects address text inside html', () => {
    for (const html of [
      '<p>Pay 0x52908400098527886E0F7030069857D2E4169EE7</p>',
      '<p>Send USDC to this wallet address instead</p>',
      '<p><span>0x529084000985278</span><span>86E0F7030069857D2E4169EE7</span></p>',
      '<p>&#48;x52908400098527886E0F7030069857D2E4169EE7</p>',
      '<img src="https://assets.tendr.test/a.png" alt="0x52908400098527886E0F7030069857D2E4169EE7">',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/wallet addresses or payment instructions/);
    }
  });

  it('rejects addresses split by invisible characters', () => {
    for (const html of [
      '<p>0x5290840009&#8203;8527886E0F7030069857D2E4169EE7</p>',
      '<p>0x5290840009&shy;8527886E0F7030069857D2E4169EE7</p>',
      '<p>0x5290840009&#x2060;8527886E0F7030069857D2E4169EE7</p>',
      '<p>Se&#8203;nd USDC to this wal&shy;let</p>',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/wallet addresses or payment instructions/);
    }
  });

  it('ordinary prose passes the whole-block checks', () => {
    const prose = [
      '<p>Ships in 2 days from Lagos and Abuja to Kano</p>',
      '<p>We started in 2019 with 3 sewing machines and a market stall in Yaba.<br>' +
        'Today our team of 14 makes every bag by hand from Nigerian leather<br>' +
        'Orders placed before 4pm leave the workshop the same day<br>' +
        'Most deliveries arrive within 2 to 5 working days<br>' +
        'Returns are free for 30 days if the bag is unused<br>' +
        'Questions? Message us any time and we reply within 24 hours</p>',
    ];
    for (const html of prose) {
      const r = sanitizeThemeHtml(html, ORIGIN);
      expect(r.ok, `${html} → ${r.ok ? '' : r.problems.join(' | ')}`).toBe(true);
    }
  });

  it('rejects element-split addresses with other words in neighbouring blocks', () => {
    for (const html of [
      '<p>Hello</p><p>1BoatSLRHtKNng</p><p>kdXEeobR76b53LETtpyT</p>',
      '<p>Wallet</p><p>bc1qar0s</p><p>rrr7xfkvy5l643lydnw9re59gtzzwf5mdq</p>',
      `<p>Hello</p><p>${'a'.repeat(32)}</p><p>${'b'.repeat(32)}</p>`,
      '<p>Hello</p><p>0x52908400098527886E0F</p><p>7030069857D2E4169EE7</p><p>World</p>',
      '<p>Ask</p><p>kola</p><p>.near</p><p>Today</p>',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/wallet addresses or payment instructions/);
    }
  });

  it('rejects base58 split into three or more pieces next to other words', () => {
    for (const html of [
      '<p>Hello</p><p>1BoatSLRHt</p><p>KNngkdXEeo</p><p>bR76b53LETtpyT</p>',
      '<p>Hello</p><p>1BoatSLRHt</p><p>KNngkdXEeo</p><p>bR76b53LETtpyT</p><p>thanks</p>',
      '<p>Hi</p><p>1Boat</p><p>SLRHt</p><p>KNngk</p><p>dXEeo</p><p>bR76b</p><p>53LETtpyT</p><p>ok</p>',
      // Long sentences glued to the first or last piece don't hide the split.
      '<p>Handmade leather bags from our small workshop in Yaba ok 1BoatSLRHt</p><p>KNngkdXEeo</p><p>bR76b53LETtpyT</p><p>hello</p>',
      '<p>hello</p><p>1BoatSLRHt</p><p>KNngkdXEeo</p><p>bR76b53LETtpyT all orders leave the workshop within two working days</p>',
      '<p>Handmade leather bags from our small workshop in Yaba ok 1BoatSLRHt</p><p>KNngkdXEeo</p><p>bR76b53LETtpyT all orders leave the workshop within two working days</p>',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/wallet addresses or payment instructions/);
    }
  });

  it('prose with "near" passes', () => {
    for (const html of [
      '<p>Pickup from 9 a.m. near the market</p>',
      '<p>Open daily. near Yaba bus stop</p>',
      '<p>See you soon.</p><p>near the big tree</p>',
    ]) {
      const r = sanitizeThemeHtml(html, ORIGIN);
      expect(r.ok, `${html} → ${r.ok ? '' : r.problems.join(' | ')}`).toBe(true);
    }
  });

  it('rejects a <br>-split base58 address', () => {
    expect(problemsOf('<p>1BoatSLRHtKNng<br>kdXEeobR76b53LETtpyT</p>').join(' ')).toMatch(
      /wallet addresses or payment instructions/,
    );
  });

  it('rejects addresses split across lines, elements or spaces', () => {
    for (const html of [
      '<p>0x52908400098527<br>886E0F7030069857D2E4169EE7</p>',
      '<p>0x52908400098527</p><p>886E0F7030069857D2E4169EE7</p>',
      '<div>0x529084</div><div>00098527886E0F</div><div>7030069857D2E4169EE7</div>',
      '<ul><li>0x52908400098527</li><li>886E0F7030069857D2E4169EE7</li></ul>',
      '<p>0x5290 8400 0985 2788 6E0F 7030 0698 57D2 E416 9EE7</p>',
    ]) {
      expect(problemsOf(html).join(' '), html).toMatch(/wallet addresses or payment instructions/);
    }
  });

  it('runs inline styles through the css rules', () => {
    expect(problemsOf('<div style="position: fixed; inset: 0">x</div>').join(' ')).toMatch(
      /position: fixed/,
    );
    expect(
      problemsOf('<div style="background: url(https://evil.test/x.png)">x</div>').join(' '),
    ).toMatch(/uploaded to Tendr/);
  });

  it('rejects Tendr class names', () => {
    expect(problemsOf('<div class="card pay-card">x</div>').join(' ')).toMatch(/pay-card/);
    expect(problemsOf('<div class="tdr-payment">x</div>').join(' ')).toMatch(/tdr-payment/);
  });

  it('rejects over 20 KB', () => {
    const html = `<p>${'a'.repeat(20 * 1024)}</p>`;
    expect(problemsOf(html)).toEqual(['HTML block is over 20 KB']);
  });
});
