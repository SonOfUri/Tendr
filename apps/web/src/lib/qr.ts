import QRCode from 'qrcode';

export type QrStyle = 'square' | 'dots';

/** An SVG data URL of a QR code for `text` (rendered locally; no network). */
export async function qrDataUrl(
  text: string,
  opts?: { style?: QrStyle; size?: number },
): Promise<string> {
  const style = opts?.style ?? 'square';
  const size = opts?.size ?? 180;
  if (style === 'dots') return dottedQrDataUrl(text, size);

  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: size,
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** QR modules drawn as dots (scannable dotted style). */
function dottedQrDataUrl(text: string, size: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const count = modules.size;
  const margin = 2;
  const total = count + margin * 2;
  const cell = size / total;
  const radius = cell * 0.42;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="geometricPrecision">`,
    `<rect width="${size}" height="${size}" fill="#ffffff"/>`,
  ];

  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (!modules.get(x, y)) continue;
      const cx = (x + margin + 0.5) * cell;
      const cy = (y + margin + 0.5) * cell;
      parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="#111111"/>`);
    }
  }
  parts.push('</svg>');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.join(''))}`;
}
