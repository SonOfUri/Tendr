import { LINK_SLUG_RE } from '@tendr/contracts';
import { headers } from 'next/headers';
import { ImageResponse } from 'next/og';
import { themeLogoUrl } from '@/lib/checkout/brand';
import { CARD_SIZE, LinkCard } from '@/lib/link-card';
import { linkTheme } from '@/lib/link-preview';
import { safeLogo } from '@/lib/og-logo';
import { fetchPublicLink, payerIpFrom } from '@/lib/payment-links';

const MERCHANT_SLUG = /^[a-z0-9-]{1,64}$/;

// `/pay/<merchant>/<link>/opengraph-image[?mode=test]`: the 1200×630 preview card (spec §4.1). A
// route handler rather than the `opengraph-image.tsx` file convention, because that convention
// cannot see the query string and so could not tell a test link from a live one. The logo is the
// theme's, drawn only when `safeLogo` accepts it (Tendr's asset origin); otherwise the merchant's
// initial. The card takes the theme's background and accent (lib/link-card.tsx).
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

  const logo = await safeLogo(themeLogoUrl(linkTheme(view)));
  return new ImageResponse(<LinkCard view={view} logo={logo} test={test} />, {
    ...CARD_SIZE,
    headers: { 'cache-control': 'public, max-age=300' },
  });
}
