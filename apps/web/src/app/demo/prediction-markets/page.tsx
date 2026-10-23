import { CheckoutEngine } from '@/components/CheckoutEngine';
import { Alert } from '@tendr/ui';

export default function PredictionMarketsDemoPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Prediction markets demo</h1>
      <p className="lead">Simulated funding of a position deposit.</p>
      <Alert tone="warning">
        This demo does not place bets, execute trades, or connect to a real market.
      </Alert>
      <CheckoutEngine
        title="Position deposit"
        description="Fund a simulated market position wallet."
        amount="25.00"
        currency="USD"
        merchantReferencePrefix="pred"
        successHint="Sandbox deposit recorded. No market action was taken."
      />
    </section>
  );
}
