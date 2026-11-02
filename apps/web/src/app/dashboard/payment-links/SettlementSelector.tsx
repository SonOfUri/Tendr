'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { LinkSettlementOptions } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { api, errorMessage, type StoreContext } from '@/lib/api';
import { chainLabel } from '@/lib/assets';
import type { DashboardPaymentLink } from '@/lib/dashboard-payment-links';
import styles from './links.module.css';

export function SettlementSelector({
  context,
  custom,
  value,
  existing,
  onMode,
  onChange,
}: {
  context: StoreContext;
  custom: boolean;
  value: string;
  existing?: DashboardPaymentLink;
  onMode(custom: boolean): void;
  onChange(asset: string): void;
}) {
  const [options, setOptions] = useState<LinkSettlementOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [chosenChain, setChosenChain] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api<LinkSettlementOptions>('/v1/payment_links/settlement-options', {
      store: context,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setOptions(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [context, attempt]);

  const selected = options?.tokens.find((t) => t.asset === value);
  const savedChain = value === existing?.settlement_asset ? existing.settlement_chain : null;
  const chain = selected?.chain ?? (value ? savedChain : null) ?? chosenChain;
  const chains = [
    ...new Set([...(options?.tokens.map((t) => t.chain) ?? []), ...(chain ? [chain] : [])]),
  ].sort((a, b) => chainLabel(a).localeCompare(chainLabel(b)));
  const tokens = options?.tokens.filter((t) => t.chain === chain) ?? [];
  const current = options?.store_default;

  return (
    <section className="form" aria-label="Settlement">
      <label className="field">
        <span>Settlement token</span>
        <select
          value={custom ? 'custom' : 'default'}
          onChange={(e) => onMode(e.target.value === 'custom')}
        >
          <option value="default">Use store default</option>
          <option value="custom">Choose a token for this link</option>
        </select>
      </label>
      {error ? (
        <Alert tone="warning">
          Could not load settlement tokens: {error}{' '}
          <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            Retry tokens
          </Button>
        </Alert>
      ) : (
        !options && <Spinner label="Loading settlement tokens" />
      )}
      {custom ? (
        <>
          <div className={styles.columns}>
            <label className="field">
              <span>Asset chain</span>
              <select
                required
                value={chain}
                onChange={(e) => {
                  setChosenChain(e.target.value);
                  onChange('');
                }}
              >
                <option value="">Choose a chain</option>
                {chains.map((c) => (
                  <option key={c} value={c}>
                    {chainLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Token to receive</span>
              <select required value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">Choose a token</option>
                {value && !selected && (
                  <option value={value}>
                    {existing?.settlement_symbol ?? value} (saved selection)
                  </option>
                )}
                {tokens.map((t) => (
                  <option key={t.asset} value={t.asset}>
                    {t.symbol}
                    {tokens.filter((other) => other.symbol === t.symbol).length > 1
                      ? ` · ${t.asset}`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">
            Payments are credited to your Tendr account in this token. The chain identifies the
            asset version; it does not send funds to an external wallet. You choose a withdrawal
            destination separately.
          </p>
          {value && <p className="address small muted">{value}</p>}
          {options && value && !selected && (
            <Alert tone="warning">
              This saved token is not in the current catalog. Choose a supported token before
              accepting new payments.
            </Alert>
          )}
        </>
      ) : current ? (
        <p className="muted small">
          Store default:{' '}
          <strong>
            {current.symbol ?? current.asset}
            {current.chain ? ` · ${chainLabel(current.chain)}` : ''}
          </strong>
          .{' '}
          {current.payout_mode === 'intents'
            ? 'Credited to your Tendr account.'
            : 'Paid to your store’s configured external wallet.'}{' '}
          New checkout sessions follow changes to your store default.
        </p>
      ) : (
        options && (
          <p className="muted small">
            No store default is set. <Link href="/dashboard/settings/payout">Set a default</Link> or
            choose a token for this link.
          </p>
        )
      )}
      {existing && (
        <p className="muted small">
          Changing this choice affects new checkout sessions. Checkouts already started keep their
          original token.
        </p>
      )}
    </section>
  );
}
