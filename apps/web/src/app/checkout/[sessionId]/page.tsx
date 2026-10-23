import { HostedCheckout } from '@/components/HostedCheckout';

export default async function HostedCheckoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Hosted checkout</h1>
      <p className="lead">Session {sessionId}</p>
      <HostedCheckout sessionId={sessionId} />
    </section>
  );
}
