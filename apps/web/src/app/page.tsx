import Link from 'next/link';
import { Button } from '@tendr/ui';

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="brand" style={{ color: 'var(--tendr-cyan)', marginBottom: '1rem' }}>
            Tendr
          </p>
          <h1>One checkout. Every way to pay.</h1>
          <p>
            Let customers pay with supported digital assets across networks. Tendr handles the
            payment complexity, so your product doesn’t have to.
          </p>
          <div className="cta-row">
            <Link href="/dashboard">
              <Button>Build with Tendr</Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Checkout without rebuilding every rail</h2>
        <p className="lead">
          Integrate once with the Widget, API, or SDK. Tendr coordinates supported payment routes
          and returns a verified status your app can trust.
        </p>
        <div className="grid-3">
          <div className="tile">
            <h3>1. Create a session</h3>
            <p>Pass amount, currency, and return URLs. Sandbox mode is the default.</p>
          </div>
          <div className="tile">
            <h3>2. Present options</h3>
            <p>Customers review a quote for supported assets and networks only.</p>
          </div>
          <div className="tile">
            <h3>3. Verify, then fulfill</h3>
            <p>Only server-side verification can mark a payment settled.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Built for real product surfaces</h2>
        <p className="lead">
          E-commerce, fintech funding, gaming unlocks, and simulated prediction-market deposits —
          one shared checkout engine.
        </p>
        <div className="grid-3">
          <div className="tile">
            <h3>E-commerce</h3>
            <p>Confirm orders after settlement, not after a button click.</p>
          </div>
          <div className="tile">
            <h3>Fintech</h3>
            <p>Fund features with clearly labelled sandbox balances.</p>
          </div>
          <div className="tile">
            <h3>Gaming</h3>
            <p>Unlock items only after payment reaches a verified success state.</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Developer-first API</h2>
        <p className="lead">
          Honest about support: Tendr only presents routes that are configured. NEAR Intents may
          power execution for supported routes—it is not the product brand.
        </p>
        <pre className="code-panel">{`POST /v1/checkout/sessions
{
  "merchantReference": "order_123",
  "amount": "49.99",
  "currency": "USD",
  "successUrl": "https://merchant.example/success",
  "cancelUrl": "https://merchant.example/cancel",
  "mode": "sandbox"
}`}</pre>
      </section>

      <section className="section">
        <h2>FAQ</h2>
        <div className="tile">
          <h3>Does Tendr support every asset and chain?</h3>
          <p>No. Support depends on configured integrations, liquidity, and verification.</p>
        </div>
        <div className="tile">
          <h3>Is the demo moving real money?</h3>
          <p>No. Sandbox mode is deterministic simulation and is always labelled.</p>
        </div>
        <div className="tile">
          <h3>Where does NEAR fit?</h3>
          <p>
            NEAR Intents is an optional execution adapter behind Tendr for supported routes. Live
            settlement is not enabled in this scaffold.
          </p>
        </div>
      </section>
    </>
  );
}
