'use client';

import { useState } from 'react';
import { submitRefundAddressByToken } from '@/lib/checkout/api';
import { publicEnv } from '@/lib/env';
import { ReturnAddressForm } from '../components/ReturnAddressForm';

export function RefundAddressByToken({ token }: { token: string | null }) {
  const [done, setDone] = useState(false);

  return (
    <div className="pay-card">
      <section className="pay-section" aria-labelledby="pay-link-title">
        <h1 id="pay-link-title" className="pay-title">
          Tell us where to send your money back
        </h1>
        {!token ? (
          <p role="alert">
            This link is incomplete. Open it again from your email, or contact the store.
          </p>
        ) : done ? (
          <p role="status">Thanks. We&apos;ll send your money to that address.</p>
        ) : (
          <>
            <p>
              Your payment came from an exchange, so we can&apos;t send it straight back. Give us an
              address you control and we&apos;ll send it there. The cost of sending it is taken from
              the amount returned.
            </p>
            <ReturnAddressForm
              chains={[]}
              submit={async (address, chain) => {
                await submitRefundAddressByToken(
                  { baseUrl: publicEnv.apiBaseUrl },
                  { token, address, chain },
                );
              }}
              onDone={() => setDone(true)}
            />
          </>
        )}
      </section>
      <p className="pay-foot muted small">Payments by Tendr</p>
    </div>
  );
}
