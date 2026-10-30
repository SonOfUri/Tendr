import { describe, expect, it } from 'vitest';
import { sniffAsset } from './sniff.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(16)]);
const svg = Buffer.from('  \n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const xmlSvg = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg></svg>');

describe('sniffAsset', () => {
  it('detects each format by bytes not name', () => {
    expect(sniffAsset(png)).toEqual({ mime: 'image/png' });
    expect(sniffAsset(jpeg)).toEqual({ mime: 'image/jpeg' });
    expect(sniffAsset(webp)).toEqual({ mime: 'image/webp' });
    expect(sniffAsset(gif)).toEqual({ mime: 'image/gif' });
    expect(sniffAsset(Buffer.from('GIF87a\x01\x00', 'latin1'))).toEqual({ mime: 'image/gif' });
    expect(sniffAsset(woff2)).toEqual({ mime: 'font/woff2' });
    expect(sniffAsset(svg)).toEqual({ mime: 'image/svg+xml' });
    expect(sniffAsset(xmlSvg)).toEqual({ mime: 'image/svg+xml' });
    // A UTF-8 byte-order mark is not content.
    expect(sniffAsset(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), svg]))).toEqual({
      mime: 'image/svg+xml',
    });
    // Other fonts and arbitrary bytes are not accepted.
    expect(sniffAsset(Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(16)]))).toBeNull();
    expect(sniffAsset(Buffer.from([0, 1, 0, 0, 0, 0x10]))).toBeNull();
    expect(sniffAsset(Buffer.alloc(0))).toBeNull();
  });

  it('rejects html disguised as png', () => {
    // A file named logo.png whose bytes are HTML: the name is never consulted.
    expect(sniffAsset(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffAsset(Buffer.from('<!DOCTYPE html><svg></svg>'))).toBeNull();
    // <?xml must be followed by <svg, not some other root.
    expect(sniffAsset(Buffer.from('<?xml version="1.0"?><html></html>'))).toBeNull();
    expect(sniffAsset(Buffer.from('<svgfoo></svgfoo>'))).toBeNull();
  });
});
