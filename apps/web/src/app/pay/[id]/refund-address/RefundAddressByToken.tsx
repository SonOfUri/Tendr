'use client';

import { useState } from 'react';
import { submitRefundAddressByToken } from '@/lib/checkout/api';
import { publicEnv } from '@/lib/env';
import { ReturnAddressForm } from '../components/ReturnAddressForm';

export function RefundAddressByToken({
  token,
  testnet = false,
  chains = [],
}: {
  token: string | null;
  testnet?: boolean;
  chains?: string[];
}) {
  const [done, setDone] = useState(false);
  const [kept, setKept] = useState(false);

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
          <p role="status">
            {kept
              ? 'The amount remaining after network fees is below the $1 return minimum and stays with the store.'
              : 'Your return address was saved. The store will review and approve the return.'}
          </p>
        ) : (
          <>
            <p>
              Give us a wallet address you control for your return. The cost of sending it is taken
              from the amount returned.
            </p>
            <ReturnAddressForm
              chains={chains}
              testnet={testnet}
              submit={async (address, chain) => {
                const result = await submitRefundAddressByToken(
                  { baseUrl: publicEnv.apiBaseUrl },
                  { token, address, chain },
                );
                setKept(result.status === 'kept_small');
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
