import { notFound } from 'next/navigation';
import { RefundAddressByToken } from './RefundAddressByToken';

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

// The emailed "tell us where to send your money back" link:
// `/pay/<session id>/refund-address?t=<token>`. The single-use token in the query authenticates
// the address (POST /v1/checkout/refund-address); no client secret is needed.
export default async function RefundAddressPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: sessionId } = await params;
  if (!SESSION_ID.test(sessionId)) notFound();
  const t = (await searchParams).t;
  const token = typeof t === 'string' && t.length > 0 && t.length <= 256 ? t : null;
  return <RefundAddressByToken token={token} />;
}
