import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { apiConsoleEnabled } from '@/lib/api-console/enabled';
import ApiConsole from './ApiConsole';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Tendr API console',
  robots: { index: false, follow: false },
};

export default function ApiConsolePage() {
  if (!apiConsoleEnabled(process.env.NODE_ENV, process.env.API_CONSOLE_ENABLED)) notFound();
  return <ApiConsole />;
}
