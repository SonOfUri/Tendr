import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { localMailEnabled } from '@/lib/local-mail-policy';
import LocalInbox from './LocalInbox';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Tendr local inbox',
  robots: { index: false, follow: false },
};
export default async function LocalMailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  if (!localMailEnabled(process.env)) notFound();
  if ((await headers()).get('host') !== new URL(process.env.WEB_URL!).host) notFound();
  const { email } = await searchParams;
  return <LocalInbox initialEmail={typeof email === 'string' ? email : ''} />;
}
