// What an uploaded theme asset really is, judged by its bytes (magic numbers). The file name and
// the client's declared content type are never consulted.

export type AssetMime =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml' | 'font/woff2';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const startsWith = (buf: Buffer, magic: Buffer | string, at = 0) => {
  const m = typeof magic === 'string' ? Buffer.from(magic, 'latin1') : magic;
  return buf.length >= at + m.length && buf.subarray(at, at + m.length).equals(m);
};

/** How much of a file is read to find an SVG's root element. */
const SVG_HEAD_BYTES = 4096;

/**
 * Whether the text's first token is `<svg`, or an XML declaration followed (after whitespace,
 * comments and a doctype-free prolog) by `<svg`. An HTML document never counts.
 */
function isSvg(buf: Buffer): boolean {
  const body = startsWith(buf, UTF8_BOM) ? buf.subarray(UTF8_BOM.length) : buf;
  let text = body.subarray(0, SVG_HEAD_BYTES).toString('utf8').trimStart();
  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>');
    if (end < 0) return false;
    text = text.slice(end + 2);
    // Comments may sit between the declaration and the root.
    for (;;) {
      text = text.trimStart();
      if (!text.startsWith('<!--')) break;
      const close = text.indexOf('-->');
      if (close < 0) return false;
      text = text.slice(close + 3);
    }
  }
  return /^<svg[\s>/]/.test(text);
}

/** The asset's type by magic number, or null when it is none of the accepted formats. */
export function sniffAsset(buf: Buffer): { mime: AssetMime } | null {
  if (startsWith(buf, PNG)) return { mime: 'image/png' };
  if (startsWith(buf, JPEG)) return { mime: 'image/jpeg' };
  if (startsWith(buf, 'RIFF') && startsWith(buf, 'WEBP', 8)) return { mime: 'image/webp' };
  if (startsWith(buf, 'GIF87a') || startsWith(buf, 'GIF89a')) return { mime: 'image/gif' };
  if (startsWith(buf, 'wOF2')) return { mime: 'font/woff2' };
  if (isSvg(buf)) return { mime: 'image/svg+xml' };
  return null;
}
