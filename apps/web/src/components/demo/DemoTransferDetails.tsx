'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '@/lib/checkout/format';
import { QrImage } from '@/components/QrImage';
import { useNow } from '@/app/pay/[id]/components/useNow';

/** Quote hold window used for the progress track (matches typical ~12 min price lock). */
const QUOTE_WINDOW_MS = 12 * 60 * 1000;

function CopyChip({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);

  return (
    <button
      type="button"
      className="demo-copy-chip"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setState('copied'),
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      )}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
    </button>
  );
}

type Props = {
  address: string;
  amount: string;
  symbol: string;
  network: string;
  deadline: string;
  /** Simulator only: the deposit address cannot receive a payment. */
  simulated?: boolean;
  /** Tidepool: the deposit receives tokens on the selected test network. */
  testnet?: boolean;
};

export function DemoTransferDetails({
  address,
  amount,
  symbol,
  network,
  deadline,
  simulated = false,
  testnet = false,
}: Props) {
  const now = useNow();
  const left = Date.parse(deadline) - now;
  const expired = left <= 0;
  const progress = Math.min(1, Math.max(0, left / QUOTE_WINDOW_MS));
  const minutesLeft = Math.max(0, Math.ceil(left / 60_000));

  return (
    <div className="demo-transfer">
      <div
        className="demo-transfer-timer"
        data-expired={expired ? 'true' : 'false'}
        role="status"
        aria-live="polite"
      >
        <div className="demo-transfer-timer-top">
          <span className="demo-transfer-timer-label">
            {expired ? 'Price expired' : 'Price holds for'}
          </span>
          <span className="demo-transfer-timer-value" aria-hidden>
            {formatCountdown(left)}
          </span>
          <span className="sr-only">
            {expired
              ? 'Price expired'
              : minutesLeft <= 1
                ? 'Less than a minute left on this price'
                : `${minutesLeft} minutes left on this price`}
          </span>
        </div>
        <div className="demo-transfer-timer-track" aria-hidden>
          <div className="demo-transfer-timer-fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>

      <div className="demo-transfer-qr">
        <QrImage value={address} label={`QR code for ${address}`} size={148} />
      </div>

      <div className="demo-transfer-row">
        <div>
          <p className="demo-transfer-label">Amount</p>
          <p className="demo-transfer-value">
            {amount} {symbol}
          </p>
        </div>
        <CopyChip value={amount} label={`Copy amount ${amount} ${symbol}`} />
      </div>

      <div className="demo-transfer-row">
        <div className="demo-transfer-addr-wrap">
          <p className="demo-transfer-label">Deposit address</p>
          <p className="demo-transfer-addr">{address}</p>
        </div>
        <CopyChip value={address} label="Copy deposit address" />
      </div>

      <p className="demo-transfer-warn" role="note">
        {simulated ? (
          <>
            <strong>Test mode</strong> — this address is fake. Don&apos;t send real {symbol}. Use
            Simulate a payment instead.
          </>
        ) : testnet ? (
          <>
            Send exactly{' '}
            <strong>
              {amount} test {symbol}
            </strong>{' '}
            on <strong>{network}</strong>. Keep test NEAR, ETH or SOL for test network fees. These
            tokens have no monetary value.
          </>
        ) : (
          <>
            Send only on <strong>{network}</strong>, exactly{' '}
            <strong>
              {amount} {symbol}
            </strong>
            . Wrong network or amount can lose funds.
          </>
        )}
      </p>
    </div>
  );
}
