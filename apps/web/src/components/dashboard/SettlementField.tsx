'use client';

import { useEffect, useState } from 'react';
import type { LinkSettlementOptions } from '@tendr/contracts';
import { AssetGridPicker } from '@/components/dashboard/AssetGridPicker';
import { ChainLogo, TokenLogo } from '@/components/dashboard/asset-logos';
import { Select } from '@/components/dashboard/Select';
import { toast } from '@/components/toast';
import { api, errorMessage } from '@/lib/api';
import { chainLabel } from '@/lib/assets';
import { loadIntentsCatalog } from '@/lib/intents-catalog';

/** Store-default or an explicit Intents settlement token for one payment link. */
export function SettlementField({
  value,
  onChange,
  disabled,
}: {
  /** Null follows the store default. */
  value: string | null;
  onChange: (asset: string | null) => void;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<LinkSettlementOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [chain, setChain] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    // Store default stays mode-scoped; the token/chain grid uses the live 1Click catalog
    // (same source as saved addresses and withdrawals).
    void Promise.all([
      api<LinkSettlementOptions>('/v1/payment_links/settlement-options', {
        signal: controller.signal,
      }),
      loadIntentsCatalog(controller.signal),
    ])
      .then(([mode, catalog]) => {
        if (controller.signal.aborted) return;
        setFailed(false);
        setOptions({
          ...mode,
          tokens: catalog.tokens,
          chains: catalog.chains,
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setFailed(true);
        toast.error(errorMessage(err));
      });
    return () => controller.abort();
  }, []);

  const tokens = options?.tokens ?? [];
  const selected = tokens.find((t) => t.asset === value) ?? null;
  const chains = (
    options?.chains?.length ? options.chains : [...new Set(tokens.map((t) => t.chain))]
  ).filter((id) => tokens.some((t) => t.chain === id));
  const activeChain = selected?.chain ?? chain;
  const onChain = tokens.filter((t) => t.chain === activeChain);
  const missing = Boolean(value && options && !selected);

  if (failed) return null;
  if (!options) return <p className="dash-muted dash-small">Loading settlement tokens…</p>;
  if (tokens.length === 0) return null;

  return (
    <div className="stack">
      <label className="field">
        <span>Settlement token</span>
        <Select
          ariaLabel="Settlement token"
          className="tendr-select--field"
          value={value === null ? 'default' : 'custom'}
          disabled={disabled}
          onChange={(next) => {
            if (next === 'default') onChange(null);
            else onChange(onChain[0]?.asset ?? tokens[0]?.asset ?? null);
          }}
          options={[
            {
              value: 'default',
              label: options.store_default?.symbol
                ? `Store default (${options.store_default.symbol})`
                : 'Store default',
            },
            { value: 'custom', label: 'Choose a token' },
          ]}
        />
      </label>
      {value !== null ? (
        <div className="row">
          <label className="field">
            <span>Chain</span>
            <AssetGridPicker
              ariaLabel="Settlement chain"
              title="Chain"
              value={activeChain}
              disabled={disabled}
              onChange={(next) => {
                setChain(next);
                const first = tokens.find((t) => t.chain === next);
                onChange(first?.asset ?? null);
              }}
              options={chains.map((id) => ({
                value: id,
                label: chainLabel(id),
                icon: <ChainLogo chain={id} />,
              }))}
            />
          </label>
          <label className="field">
            <span>Token</span>
            <AssetGridPicker
              ariaLabel="Settlement asset"
              title="Token"
              value={selected?.asset ?? value}
              disabled={disabled}
              onChange={onChange}
              options={onChain.map((t) => ({
                value: t.asset,
                label: t.symbol,
                icon: <TokenLogo symbol={t.symbol} assetId={t.asset} />,
              }))}
            />
          </label>
        </div>
      ) : null}
      {missing ? (
        <p className="dash-muted dash-small">
          The saved token is not in the current catalog. Pick another, or return to the store default.
        </p>
      ) : null}
      <p className="dash-muted dash-small">
        {options.store_default?.payout_mode === 'intents'
          ? 'This credits the token inside the Intents wallet. It does not pay out to an outside address.'
          : 'New checkout sessions use this choice. Sessions already started keep the token they were given.'}{' '}
        {options.store_default
          ? null
          : 'No store default is set yet. Pick a token here, or set the default on the wallet page.'}
      </p>
    </div>
  );
}
