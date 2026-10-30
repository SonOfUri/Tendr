import { LINK_SLUG_RE } from '@tendr/contracts';
import { headers } from 'next/headers';
import QRCode from 'qrcode';
import { serverEnv } from '@/lib/env';
import { modeQuery } from '@/lib/link-preview';
import { fetchPublicLink, payerIpFrom } from '@/lib/payment-links';

const MERCHANT_SLUG = /^[a-z0-9-]{1,64}$/;
const CACHE = 'public, max-age=300';

// `/pay/<merchant>/<link>/qr[?mode=test][&format=svg]`: the link's address as a QR code (spec §3).
// PNG by default (1024 px, 4-module quiet zone, error correction M), SVG on request. A real 404
// for a link that doesn't exist; cached for five minutes so a deleted link disappears soon.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; link: string }> },
) {
  const { id: merchant, link } = await params;
  if (!MERCHANT_SLUG.test(merchant) || !LINK_SLUG_RE.test(link)) {
    return new Response('Not found', { status: 404 });
  }
  const url = new URL(request.url);
  const test = url.searchParams.get('mode') === 'test';
  const view = await fetchPublicLink(merchant, link, test, payerIpFrom(await headers()));
  if (!view) return new Response('Not found', { status: 404 });

  const target = `${serverEnv().linkBaseUrl}/pay/${merchant}/${link}${modeQuery(test)}`;
  const opts = { margin: 4, errorCorrectionLevel: 'M' as const };
  if (url.searchParams.get('format') === 'svg') {
    const svg = await QRCode.toString(target, { ...opts, type: 'svg' });
    return new Response(svg, {
      headers: { 'content-type': 'image/svg+xml', 'cache-control': CACHE },
    });
  }
  const png = await QRCode.toBuffer(target, { ...opts, type: 'png', width: 1024 });
  return new Response(new Uint8Array(png), {
    headers: { 'content-type': 'image/png', 'cache-control': CACHE },
  });
}
