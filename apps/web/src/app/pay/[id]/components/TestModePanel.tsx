'use client';

import { useState } from 'react';
import type { CheckoutClient, SimulateScenario } from '@/lib/checkout/api';

const PAY: { scenario: SimulateScenario; label: string }[] = [
  { scenario: 'exact', label: 'Pay the exact amount' },
  { scenario: 'underpay', label: 'Pay too little' },
  { scenario: 'overpay', label: 'Pay too much' },
  { scenario: 'late', label: 'Pay after it expires' },
  { scenario: 'failed', label: 'Payment fails' },
];
const TOPUP: { scenario: SimulateScenario; label: string }[] = [
  { scenario: 'topup', label: 'Send the rest' },
];

/** Test mode only: simulate the shopper's payment (no real money moves). */
export function TestModePanel({
  client,
  kind,
  onDone,
}: {
  client: CheckoutClient;
  kind: 'pay' | 'topup';
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(scenario: SimulateScenario) {
    setBusy(true);
    setError(null);
    try {
      await client.simulate(scenario);
      onDone();
    } catch {
      setError("Couldn't simulate that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pay-test">
      <p className="small">
        <strong>Test mode.</strong> Simulate a payment:
      </p>
      <div className="row">
        {(kind === 'pay' ? PAY : TOPUP).map((s) => (
          <button
            key={s.scenario}
            type="button"
            className="pay-button pay-button-secondary pay-button-small"
            disabled={busy}
            onClick={() => void run(s.scenario)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="pay-error small" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
