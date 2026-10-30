import { LINK_SLUG_RE } from '@tendr/contracts';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchPublicLink, payerIpFrom } from '@/lib/payment-links';
import { LinkPay } from './LinkPay';

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Signup slugs: lower-case letters, digits and hyphens (NEAR account labels). */
const MERCHANT_SLUG = /^[a-z0-9-]{1,64}$/;

// A payment link: `/pay/<merchant slug>/<link slug>[?mode=test]` (spec §3, §4). Server-rendered so
// chat apps can read its preview; nothing is created until the payer presses "Pay". A session id
// in the first segment is a checkout (`/pay/<session>` and its `refund-address` page), never a
// merchant, so it 404s here. Unknown links 404 too.
export default async function PaymentLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; link: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: merchant, link } = await params;
  if (SESSION_ID.test(merchant) || !MERCHANT_SLUG.test(merchant) || !LINK_SLUG_RE.test(link)) {
    notFound();
  }
  const test = (await searchParams).mode === 'test';
  const view = await fetchPublicLink(merchant, link, test, payerIpFrom(await headers()));
  if (!view) notFound();
  return <LinkPay view={view} merchant={merchant} link={link} test={test} />;
}
