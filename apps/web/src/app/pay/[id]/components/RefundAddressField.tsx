'use client';

import { useEffect, useId, useState } from 'react';
import { isValidAddress } from '@/lib/checkout/address';
import { networkName } from '@/lib/checkout/format';

/**
 * The optional "Your address on <network>, in case we need to send money back" field for a manual
 * send. The address is format-checked here; saving or removing it gets a new quote (it becomes
 * where any money is sent back).
 */
export function RefundAddressField({
  blockchain,
  saved,
  busy,
  error,
  onSave,
}: {
  blockchain: string;
  /** The address the current quote returns money to, or null (returns go through the store). */
  saved: string | null;
  busy: boolean;
  /** An error from the last save (e.g. the address was refused). */
  error: string | null;
  onSave: (address: string | null) => void;
}) {
  const id = useId();
  const network = networkName(blockchain);
  const [value, setValue] = useState(saved ?? '');
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => setValue(saved ?? ''), [saved]);

  const trimmed = value.trim();
  const changed = trimmed !== (saved ?? '');

  function save() {
    if (!trimmed) {
      setInvalid(null);
      onSave(null);
      return;
    }
    if (!isValidAddress(blockchain, trimmed)) {
      setInvalid(`That doesn't look like a ${network} address. Check it and try again.`);
      return;
    }
    setInvalid(null);
    onSave(trimmed);
  }

  const message = invalid ?? error;
  return (
    <form
      className="pay-refund"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="field" htmlFor={id}>
        <span>
          Your address on {network}, in case we need to send money back{' '}
          <span className="muted">(optional)</span>
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={message ? true : undefined}
          aria-describedby={`${id}-help`}
        />
      </label>
      <p
        id={`${id}-help`}
        className={message ? 'pay-error small' : 'muted small'}
        aria-live="polite"
      >
        {message ??
          (saved
            ? 'Saved. If any money needs to come back, it goes to this address.'
            : 'Leave it empty and the store will help send any money back.')}
      </p>
      {changed ? (
        <button type="submit" className="pay-button pay-button-secondary" disabled={busy}>
          {trimmed ? 'Save address' : 'Remove address'}
        </button>
      ) : null}
    </form>
  );
}
