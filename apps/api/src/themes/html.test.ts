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
