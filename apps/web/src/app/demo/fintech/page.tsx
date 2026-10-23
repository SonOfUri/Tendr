import { CheckoutEngine } from '@/components/CheckoutEngine';
import { Alert } from '@tendr/ui';

export default function FintechDemoPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Fintech demo</h1>
      <p className="lead">Fund a simulated premium analytics feature.</p>
      <Alert tone="warning">Simulated balance only — no real settlement or bank transfer.</Alert>
      <CheckoutEngine
        title="Premium Analytics (30 days)"
        description="Sandbox funding for an in-app feature unlock."
        amount="19.00"
        currency="USD"
        merchantReferencePrefix="fintech"
        successHint="Sandbox balance credited. Feature unlocked for this demo session."
      />
    </section>
  );
}
