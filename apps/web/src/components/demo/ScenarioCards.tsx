'use client';

import type { DemoDefinition } from '@/lib/demo';
import { DemoButtonLabel } from './DemoButtonLabel';
import { EcommerceCart, type CartPricing } from './EcommerceCart';
import { GamingStore } from './GamingStore';
import { PredictionMarket } from './PredictionMarket';

type Props = {
  demo: DemoDefinition;
  busy: boolean;
  onFund: (amount?: string) => void;
  onCartPricingChange?: (pricing: CartPricing) => void;
};

function Money({ amount }: { amount: string }) {
  const [whole, fraction = '00'] = amount.split('.');
  return (
    <p className="demo-card-amount">
      $ {whole}
      <span>.{fraction.padEnd(2, '0').slice(0, 2)}</span>
    </p>
  );
}

export function ScenarioCard({ demo, busy, onFund, onCartPricingChange }: Props) {
  if (demo.slug === 'fintech') {
    const [change, period = 'Last 30 days'] = (demo.changeLabel ?? '+ 13% ($2.77) · Last 30 days').split(
      ' · ',
    );
    return (
      <div className="demo-card">
        <p className="demo-card-label">Dashboard</p>
        <Money amount={demo.amount} />
        <p className="demo-card-meta">
          <strong>{change}</strong>
          {' · '}
          {period}
        </p>
        <div className="demo-card-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => onFund()} aria-busy={busy}>
            <DemoButtonLabel busy={busy} busyLabel="Opening">
              + Fund
            </DemoButtonLabel>
          </button>
          <button type="button" disabled>
            − Withdraw
          </button>
        </div>
      </div>
    );
  }

  if (demo.slug === 'gaming') {
    return <GamingStore demo={demo} busy={busy} onUnlock={() => onFund()} />;
  }

  if (demo.slug === 'prediction-markets') {
    return <PredictionMarket demo={demo} busy={busy} onDeposit={(amount) => onFund(amount)} />;
  }

  // ecommerce default — real-world cart
  return (
    <EcommerceCart
      busy={busy}
      onCheckout={(amount) => onFund(amount)}
      onPricingChange={onCartPricingChange}
    />
  );
}
