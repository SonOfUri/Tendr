'use client';

import { useId, useState } from 'react';
import { CheckoutApiError } from '@/lib/checkout/api';
import { isValidAddress } from '@/lib/checkout/address';
import { networkName } from '@/lib/checkout/format';
import { toast } from '@/components/toast';

/** Networks a return can be sent on (the API narrows this per refund). */
export const RETURN_NETWORKS = [
  'near',
  'eth',
  'base',
  'arb',
  'pol',
  'bsc',
  'op',
  'avax',
  'sol',
  'tron',
  'btc',
];

/**
 * "Tell us where to send it": the network and "Your address on <network>", format-checked, for a
 * return that is waiting on the shopper's address. Used on the checkout page (client secret) and
 * on the emailed link's page (single-use token); `submit` makes the call.
 */
export function ReturnAddressForm({
  chains,
  submit,
  onDone,
  testnet = false,
}: {
  /** The networks this return can go to; empty means any supported network. */
  chains: string[];
  submit: (address: string, chain: string) => Promise<void>;
  onDone: () => void;
  testnet?: boolean;
}) {
  const id = useId();
  const [allowed, setAllowed] = useState(chains.length > 0 ? chains : RETURN_NETWORKS);
  const [chain, setChain] = useState(allowed[0] ?? 'near');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const network = networkName(chain, testnet);

  async function send() {
    const value = address.trim();
    if (!isValidAddress(chain, value)) {
      setInvalid(true);
      toast.error(`That doesn't look like a ${network} address. Check it and try again.`);
      return;
    }
    setBusy(true);
    setInvalid(false);
    try {
      await submit(value, chain);
      onDone();
    } catch (err) {
      setInvalid(true);
      toast.error(returnAddressError(err, setAllowed, setChain));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {allowed.length > 1 ? (
        <label className="field">
          <span>Network</span>
          <select value={chain} onChange={(e) => setChain(e.target.value)}>
            {allowed.map((c) => (
              <option key={c} value={c}>
                {networkName(c, testnet)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field" htmlFor={id}>
        <span>Your address on {network}</span>
        <input
          id={id}
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setInvalid(false);
          }}
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-msg`}
        />
      </label>
      <p id={`${id}-msg`} className="muted small">
        Use an address you control, such as your own wallet. Not an exchange deposit address.
      </p>
      <button type="submit" className="pay-button" disabled={busy || !address.trim()}>
        {busy ? 'Saving…' : 'Send my money here'}
      </button>
    </form>
  );
}

function returnAddressError(
  err: unknown,
  setAllowed: (c: string[]) => void,
  setChain: (c: string) => void,
): string {
  if (!(err instanceof CheckoutApiError)) return 'Something went wrong. Please try again.';
  const chains = (err.details as { chains?: unknown } | undefined)?.chains;
  if (err.code === 'VALIDATION_ERROR' && Array.isArray(chains)) {
    const list = chains.filter((c): c is string => typeof c === 'string');
    if (list.length > 0) {
      setAllowed(list);
      setChain(list[0]!);
      return `This money can only be sent back on ${list.map((chain) => networkName(chain)).join(' or ')}. Choose one and enter your address there.`;
    }
  }
  switch (err.code) {
    case 'VALIDATION_ERROR':
      return "That address doesn't work for this network. Check it and try again.";
    case 'WALLET_NOT_ALLOWED':
      return "This address can't receive the money. Use a different one.";
    case 'UNAUTHORIZED':
      return 'This link is invalid or has expired. Check your email for a newer link, or contact the store.';
    case 'NOT_FOUND':
    case 'CONFLICT':
      return 'We already have an address for this. Nothing more to do.';
    case 'RATE_LIMITED':
      return 'Too many tries. Wait a minute, then try again.';
    case 'NETWORK_ERROR':
      return "We can't reach Tendr. Check your connection and try again.";
    default:
      return 'Please try again in a few minutes.';
  }
}
