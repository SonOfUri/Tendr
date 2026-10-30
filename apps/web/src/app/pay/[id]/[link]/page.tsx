import { LINK_SLUG_RE } from '@tendr/contracts';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { serverEnv } from '@/lib/env';
import { linkDescription, modeQuery } from '@/lib/link-preview';
import { fetchPublicLink, payerIpFrom } from '@/lib/payment-links';
import { LinkPay } from './LinkPay';

// `generateMetadata` and the page both read the link; one render path makes one API call (and one
// hit on the payer's per-IP limit).
const readLink = cache(fetchPublicLink);

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Signup slugs: lower-case letters, digits and hyphens (NEAR account labels). */
const MERCHANT_SLUG = /^[a-z0-9-]{1,64}$/;

type PageProps = {
  params: Promise<{ id: string; link: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Open Graph and Twitter tags (spec §4.1); the card image is `./opengraph-image` (same mode). */
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id: merchant, link } = await params;
  const missing = { title: 'Payment link not found' };
  if (SESSION_ID.test(merchant) || !MERCHANT_SLUG.test(merchant) || !LINK_SLUG_RE.test(link)) {
    return missing;
  }
  const test = (await searchParams).mode === 'test';
  const view = await readLink(merchant, link, test, payerIpFrom(await headers()));
  if (!view) return missing;

  const description = linkDescription(view, test);
  const base = `${serverEnv().linkBaseUrl}/pay/${merchant}/${link}`;
  const image = { url: `${base}/opengraph-image${modeQuery(test)}`, width: 1200, height: 630 };
  return {
    title: view.title,
    description,
    openGraph: { type: 'website', title: view.title, description, images: [image] },
    twitter: { card: 'summary_large_image', title: view.title, description, images: [image.url] },
  };
}

// A payment link: `/pay/<merchant slug>/<link slug>[?mode=test]` (spec §3, §4). Server-rendered so
// chat apps can read its preview; nothing is created until the payer presses "Pay". A session id
// in the first segment is a checkout (`/pay/<session>` and its `refund-address` page), never a
// merchant, so it 404s here. Unknown links 404 too.
export default async function PaymentLinkPage({ params, searchParams }: PageProps) {
  const { id: merchant, link } = await params;
  if (SESSION_ID.test(merchant) || !MERCHANT_SLUG.test(merchant) || !LINK_SLUG_RE.test(link)) {
    notFound();
  }
  const test = (await searchParams).mode === 'test';
  const view = await readLink(merchant, link, test, payerIpFrom(await headers()));
  if (!view) notFound();
  return <LinkPay view={view} merchant={merchant} link={link} test={test} />;
}
