import { Alert } from '@tendr/ui';
import { serverEnv } from '@/lib/env';

async function loadPayments() {
  const env = serverEnv();
  if (!env.demoMerchantApiKey) return { data: [], error: 'DEMO_MERCHANT_API_KEY not set' };
  try {
    const res = await fetch(`${env.apiBaseUrl}/v1/merchants/me/payments`, {
      headers: { Authorization: `Bearer ${env.demoMerchantApiKey}` },
      cache: 'no-store',
    });
    if (!res.ok) return { data: [], error: `API ${res.status}` };
    return (await res.json()) as { data: Array<Record<string, string>>; error?: string };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : 'Failed to load' };
  }
}

export default async function DashboardPaymentsPage() {
  const payments = await loadPayments();
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Payments</h1>
      <Alert tone="info">Sandbox payments only. Demo dashboard — not production-ready.</Alert>
      {payments.error && <Alert tone="danger">{payments.error}</Alert>}
      {!payments.error && payments.data.length === 0 && (
        <p className="muted">No payments yet. Run a demo checkout first.</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {payments.data.map((p) => (
          <li key={p.id} className="tile">
            <strong>
              {p.amount} {p.currency}
            </strong>{' '}
            — {p.status} · {p.id}
          </li>
        ))}
      </ul>
    </section>
  );
}
