'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LinkSettlementOptions } from '@tendr/contracts';
import { DemoAssetModal } from '@/components/demo/DemoAssetModal';
import '@/components/demo/demo-playground.css';
import { Select } from '@/components/dashboard/Select';
import { toast } from '@/components/toast';
import { api, errorMessage } from '@/lib/api';
import type { Token } from '@/lib/checkout/api';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { loadIntentsCatalog, type IntentsToken } from '@/lib/intents-catalog';

function intentsToCheckoutTokens(tokens: IntentsToken[]): Token[] {
  return tokens.map((t) => ({
    asset_id: t.asset,
    symbol: t.symbol,
    blockchain: t.chain,
    decimals: t.decimals,
    price_usd: null,
    popular: false,
  }));
}

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

  useEffect(() => {
    const controller = new AbortController();
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
  const assetOptions = useMemo(
    () => buildDemoAssetOptions(intentsToCheckoutTokens(tokens)),
    [tokens],
  );
  const selected = tokens.find((t) => t.asset === value) ?? null;
  const missing = Boolean(value && options && !selected);
  const pickerValue =
    value && assetOptions.some((o) => o.chainVariants.some((v) => v.assetId === value))
      ? value
      : assetOptions[0]?.chainVariants[0]?.assetId ?? assetOptions[0]?.value ?? '';

  if (failed) return null;
  if (!options) return <p className="dash-muted dash-small">Loading settlement tokens…</p>;
  if (tokens.length === 0) return null;

  return (
    <div className="stack dash-demo-asset-field">
      <label className="field">
        <span>Settlement token</span>
        <Select
          ariaLabel="Settlement token"
          className="tendr-select--field"
          value={value === null ? 'default' : 'custom'}
          disabled={disabled}
          onChange={(next) => {
            if (next === 'default') onChange(null);
            else onChange(pickerValue || tokens[0]?.asset || null);
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
        <label className="field">
          <span>Token and network</span>
          <DemoAssetModal
            options={assetOptions}
            value={pickerValue}
            disabled={disabled}
            onChange={onChange}
          />
        </label>
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
