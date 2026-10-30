import { LINK_SLUG_RE } from '@tendr/contracts';
import { headers } from 'next/headers';
import { ImageResponse } from 'next/og';
import { CARD_SIZE, LinkCard } from '@/lib/link-card';
import { safeLogo } from '@/lib/og-logo';
import { fetchPublicLink, payerIpFrom } from '@/lib/payment-links';

const MERCHANT_SLUG = /^[a-z0-9-]{1,64}$/;

// `/pay/<merchant>/<link>/opengraph-image[?mode=test]`: the 1200×630 preview card (spec §4.1). A
// route handler rather than the `opengraph-image.tsx` file convention, because that convention
// cannot see the query string and so could not tell a test link from a live one. The logo is
// drawn only when `safeLogo` accepts it; otherwise the merchant's initial.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; link: string }> },
) {
  const { id: merchant, link } = await params;
  if (!MERCHANT_SLUG.test(merchant) || !LINK_SLUG_RE.test(link)) {
    return new Response('Not found', { status: 404 });
  }
  const test = new URL(request.url).searchParams.get('mode') === 'test';
  const view = await fetchPublicLink(merchant, link, test, payerIpFrom(await headers()));
  if (!view) return new Response('Not found', { status: 404 });

  const logo = await safeLogo(view.merchant.logo_url);
  return new ImageResponse(<LinkCard view={view} logo={logo} test={test} />, {
    ...CARD_SIZE,
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
