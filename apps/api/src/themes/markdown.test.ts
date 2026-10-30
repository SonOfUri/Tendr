import { describe, expect, it } from 'vitest';
import { renderMarkdownSubset } from './markdown.js';

describe('renderMarkdownSubset', () => {
  it('escapes html', () => {
    expect(renderMarkdownSubset('<script>alert("x")</script> & <b>hi</b>')).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;hi&lt;/b&gt;</p>',
    );
    expect(renderMarkdownSubset('**<img src=x onerror=alert(1)>**')).toBe(
      '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong></p>',
    );
  });

  it('only https links', () => {
    expect(renderMarkdownSubset('See [our shop](https://shop.example/a_b?x=1&y=2).')).toBe(
      '<p>See <a href="https://shop.example/a_b?x=1&amp;y=2" rel="noopener noreferrer" target="_blank">our shop</a>.</p>',
    );
    expect(renderMarkdownSubset('[x](javascript:alert(1))')).toBe(
      '<p>[x](javascript:alert(1))</p>',
    );
    expect(renderMarkdownSubset('[x](http://shop.example)')).toBe(
      '<p>[x](http://shop.example)</p>',
    );
    expect(renderMarkdownSubset('[x](https://a.example/"onmouseover=alert(1))')).toBe(
      '<p><a href="https://a.example/%22onmouseover=alert(1" rel="noopener noreferrer" target="_blank">x</a>)</p>',
    );
  });

  it('renders bold, italic, paragraphs and lists', () => {
    const md = [
      'Hello **bold** and *italic* and __b2__ and _i2_, snake_case_word stays.',
      'Second line.',
      '',
      '- one',
      '- **two**',
      '',
      '1. first',
      '2. second',
    ].join('\n');
    expect(renderMarkdownSubset(md)).toBe(
      '<p>Hello <strong>bold</strong> and <em>italic</em> and <strong>b2</strong> and <em>i2</em>, snake_case_word stays.<br>Second line.</p>' +
        '<ul><li>one</li><li><strong>two</strong></li></ul>' +
        '<ol><li>first</li><li>second</li></ol>',
    );
  });

  it('keeps emphasis tags properly nested', () => {
    expect(renderMarkdownSubset('***x***')).toBe('<p><em><strong>x</strong></em></p>');
    expect(renderMarkdownSubset('**a _b** c_')).toBe('<p><strong>a _b</strong> c_</p>');
  });

  it('empty input renders nothing', () => {
    expect(renderMarkdownSubset('  \n\n ')).toBe('');
  });
});
