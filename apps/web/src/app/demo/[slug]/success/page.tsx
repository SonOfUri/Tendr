import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button } from '@tendr/ui';
import { getDemo } from '@/lib/demo';

export default async function DemoSuccessPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const demo = getDemo(slug);
  if (!demo) notFound();

  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1 style={{ fontFamily: 'var(--tendr-font-display)' }}>Payment received</h1>
      <Alert tone="success">{demo.successHint}</Alert>
      <p className="lead" style={{ marginTop: '1.25rem' }}>
        This success page is the merchant return URL. In production, your app would fulfill the
        order only after webhook or API confirmation of settlement.
      </p>
      <div className="cta-row">
        <Link href={`/demo/${demo.slug}`}>
          <Button variant="secondary">Back to {demo.title}</Button>
        </Link>
        <Link href="/demo">
          <Button>All demos</Button>
        </Link>
      </div>
    </section>
  );
}
