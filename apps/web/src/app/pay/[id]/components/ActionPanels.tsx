'use client';

import { useState } from 'react';
import { CheckoutApiError, type CheckoutClient, type SessionRefund } from '@/lib/checkout/api';
import { toast } from '@/components/toast';
import { ReturnAddressForm } from './ReturnAddressForm';

/** Email capture: a return needs the shopper's address and the store gave no email. */
export function EmailPanel({ client, onDone }: { client: CheckoutClient; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  async function send() {
    setBusy(true);
    setInvalid(false);
    try {
      await client.email(email.trim());
      onDone();
    } catch (err) {
      const msg =
        err instanceof CheckoutApiError && err.code === 'VALIDATION_ERROR'
          ? 'Enter a valid email address.'
          : 'Something went wrong. Please try again.';
      setInvalid(true);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pay-section pay-action" aria-labelledby="pay-email-title">
      <h2 id="pay-email-title">We need to send money back to you</h2>
      <p>
        Enter your email and we&apos;ll send you a link to tell us where. We only use it for this.
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setInvalid(false);
            }}
            autoComplete="email"
            required
            aria-invalid={invalid || undefined}
          />
        </label>
        <button type="submit" className="pay-button" disabled={busy || !email.trim()}>
          {busy ? 'Saving…' : 'Send me the link'}
        </button>
      </form>
    </section>
  );
}

/** "Tell us where to send it": a return is held until the shopper gives an address. */
export function NeedsAddressPanel({
  client,
  refund,
  onDone,
}: {
  client: CheckoutClient;
  refund: SessionRefund;
  onDone: () => void;
}) {
  return (
    <section className="pay-section pay-action" aria-labelledby="pay-address-title">
      <h2 id="pay-address-title">Tell us where to send your money back</h2>
      <p>
        Your payment came from an exchange, so we can&apos;t send it straight back. Give us an
        address you control and we&apos;ll send it there.
      </p>
      <ReturnAddressForm
        chains={refund.chains ?? []}
        submit={async (address, chain) => {
          await client.refundAddress({ refund_id: refund.id, address, chain });
        }}
        onDone={onDone}
      />
    </section>
  );
}
