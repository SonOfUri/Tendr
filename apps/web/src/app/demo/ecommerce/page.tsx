import { CheckoutEngine } from '@/components/CheckoutEngine';

export default function EcommerceDemoPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>E-commerce demo</h1>
      <p className="lead">
        Buy the Aurora Runner sneakers. The order is confirmed only after Tendr reports settlement.
      </p>
      <CheckoutEngine
        title="Aurora Runner"
        description="Limited edition sneakers — demo catalog item."
        amount="49.99"
        currency="USD"
        merchantReferencePrefix="ecom"
        successHint="Order confirmed. Fulfillment can proceed (demo)."
      />
    </section>
  );
}
