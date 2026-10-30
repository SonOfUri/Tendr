'use client';

import { useMemo, useState } from 'react';
import type { Token } from '@/lib/checkout/api';
import { networkName } from '@/lib/checkout/format';

const SHOWN_WITHOUT_SEARCH = 40;

/** Step 1: choose what to pay with. Popular tokens first (the API's order), searchable. */
export function TokenPicker({
  tokens,
  selected,
  onChoose,
  disabled,
}: {
  tokens: Token[];
  selected: string | null;
  onChoose: (token: Token) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens.slice(0, SHOWN_WITHOUT_SEARCH);
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        networkName(t.blockchain).toLowerCase().includes(q) ||
        t.blockchain.toLowerCase().includes(q),
    );
  }, [tokens, query]);

  return (
    <section className="pay-section" aria-labelledby="pay-choose-title">
      <h2 id="pay-choose-title">Pay with</h2>
      <label className="field">
        <span className="sr-only">Search tokens</span>
        <input
          type="search"
          placeholder="Search tokens or networks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
      </label>
      {shown.length === 0 ? (
        <p className="muted small">No token matches “{query.trim()}”.</p>
      ) : (
        <ul className="pay-tokens" aria-label="Tokens">
          {shown.map((t) => (
            <li key={t.asset_id}>
              <button
                type="button"
                className="pay-token"
                aria-pressed={selected === t.asset_id}
                disabled={disabled}
                onClick={() => onChoose(t)}
              >
                <span className="pay-token-symbol">{t.symbol}</span>
                <span className="muted small">{networkName(t.blockchain)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!query && tokens.length > SHOWN_WITHOUT_SEARCH ? (
        <p className="muted small">Search to see all {tokens.length} tokens.</p>
      ) : null}
    </section>
  );
}
