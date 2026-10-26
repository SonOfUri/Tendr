import QRCode from 'qrcode';

/** An SVG data URL of a QR code for `text` (rendered locally; no network). */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
