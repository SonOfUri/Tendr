import { redirect } from 'next/navigation';
import { getDemo } from '@/lib/demo';
import { notFound } from 'next/navigation';

/** Legacy deep links land on the Chainrails-style playground. */
export default async function DemoExperiencePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!getDemo(slug)) notFound();
  redirect('/demo');
}
