'use client';

import { useEffect, useId, useState } from 'react';
import { isValidAddress } from '@/lib/checkout/address';
import { networkName } from '@/lib/checkout/format';
import { toast } from '@/components/toast';

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
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setValue(saved ?? ''), [saved]);
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  const trimmed = value.trim();
  const changed = trimmed !== (saved ?? '');

  function save() {
    if (!trimmed) {
      setInvalid(false);
      onSave(null);
      return;
    }
    if (!isValidAddress(blockchain, trimmed)) {
      setInvalid(true);
      toast.error(`That doesn't look like a ${network} address. Check it and try again.`);
      return;
    }
    setInvalid(false);
    onSave(trimmed);
  }

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
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || Boolean(error) || undefined}
          aria-describedby={`${id}-help`}
        />
      </label>
      <p id={`${id}-help`} className="muted small">
        {saved
          ? 'Saved. If any money needs to come back, it goes to this address.'
          : 'Leave it empty and the store will help send any money back.'}
      </p>
      {changed ? (
        <button type="submit" className="pay-button pay-button-secondary" disabled={busy}>
          {trimmed ? 'Save address' : 'Remove address'}
        </button>
      ) : null}
    </form>
  );
}
