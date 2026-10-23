import { CheckoutEngine } from '@/components/CheckoutEngine';

export default function GamingDemoPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Gaming demo</h1>
      <p className="lead">
        Purchase the Nebula Skin. It unlocks only after payment reaches a verified success state.
      </p>
      <CheckoutEngine
        title="Nebula Skin"
        description="Cosmetic unlock — inventory grant is gated on SETTLED."
        amount="9.99"
        currency="USD"
        merchantReferencePrefix="game"
        successHint="Item unlocked. Inventory grant authorized (demo)."
      />
    </section>
  );
}
