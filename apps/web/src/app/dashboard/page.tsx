import Link from 'next/link';
import { Alert } from '@tendr/ui';

export default function DashboardPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Merchant dashboard</h1>
      <Alert tone="warning">
        Demo / development shell only. No production authentication is implemented.
      </Alert>
      <div className="grid-3" style={{ marginTop: '1.5rem' }}>
        <Link href="/dashboard/payments" className="tile">
          <h3>Payments</h3>
          <p>Review sandbox payment activity.</p>
        </Link>
        <Link href="/dashboard/developers" className="tile">
          <h3>Developers</h3>
          <p>API keys and webhook configuration (demo).</p>
        </Link>
      </div>
    </section>
  );
}
