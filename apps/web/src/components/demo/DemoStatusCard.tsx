'use client';

import { useEffect, useRef, useState } from 'react';
import type { DemoSlug } from '@/lib/demo';
import { TendrLogo } from '@/components/TendrLogo';
import { burstDemoConfetti } from '@/lib/demo/confetti';

type Props = {
  variant: 'confirming' | 'success' | 'expired';
  skin: DemoSlug;
  /** White mark on dark panels; black on light. */
  logoTone?: 'white' | 'black';
  merchantName: string;
  merchantLogoUrl: string;
  payEyebrow: string;
  amountLabel: string;
  successHint?: string;
  /** Test mode — fake addresses / simulated settlement. */
  testMode?: boolean;
  onContinue?: () => void;
  onClose?: () => void;
};

/** How far through the confirming checklist (1 = first done + second active … 3 = all done). */
const CONFIRM_STEPS = 3;
/** Time on each step before advancing (fits under the 15s total checkout timer). */
const CONFIRM_STEP_MS = 3_500;

export function DemoStatusCard({
  variant,
  skin,
  logoTone,
  merchantName,
  merchantLogoUrl,
  payEyebrow,
  amountLabel,
  successHint,
  testMode = false,
  onContinue,
  onClose,
}: Props) {
  const poweredByTone: 'white' | 'black' =
    logoTone ?? (skin === 'gaming' ? 'white' : 'black');
  const shellRef = useRef<HTMLDivElement>(null);
  /** How many steps are complete (1 = payment detected done; 3 = settlement done). */
  const [progress, setProgress] = useState(1);
  useEffect(() => {
    if (variant !== 'success' || !shellRef.current) return;
    return burstDemoConfetti(shellRef.current);
  }, [variant]);

  useEffect(() => {
    if (variant !== 'confirming') {
      setProgress(1);
      return;
    }
    // Start with step 1 done + step 2 active, then advance to settlement, then all done.
    setProgress(1);
    const toConfirmingDone = window.setTimeout(() => setProgress(2), CONFIRM_STEP_MS);
    const toSettlementDone = window.setTimeout(() => setProgress(3), CONFIRM_STEP_MS * 2);
    return () => {
      window.clearTimeout(toConfirmingDone);
      window.clearTimeout(toSettlementDone);
    };
  }, [variant]);

  const confirming = variant === 'confirming';
  const expired = variant === 'expired';
  const tickLabels =
    skin === 'gaming'
      ? (['Payment received', 'Minting unlock', 'Inventory sync'] as const)
      : (['Payment detected', 'Confirming on-chain', 'Settlement'] as const);

  const title = confirming
    ? skin === 'gaming'
      ? 'SYNCING…'
      : 'Confirming'
    : expired
      ? skin === 'gaming'
        ? 'TIMED OUT'
        : 'Expired'
      : skin === 'gaming'
        ? 'UNLOCKED'
        : 'All set';

  const eyebrow = confirming
    ? `${payEyebrow} ${merchantName}`
    : expired
      ? `${payEyebrow} ${merchantName}`
      : merchantName;

  const copy = confirming
    ? skin === 'gaming'
      ? 'Loot detected — confirming on-chain…'
      : 'Payment detected — confirming on-chain…'
    : expired
      ? skin === 'gaming'
        ? 'This checkout timed out. Start again from the store.'
        : 'This checkout has expired. Don’t send money to an address from this page.'
      : (successHint ?? 'Payment complete. You’re good to go.');

  const ariaLabel = confirming
    ? 'Confirming payment'
    : expired
      ? 'Checkout expired'
      : 'Payment complete';

  return (
    <div
      ref={shellRef}
      className="demo-status-card"
      data-variant={variant}
      data-skin={skin}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
    >
      <div className="demo-status-card-top">
        <div className="demo-checkout-store">
          {merchantLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={merchantLogoUrl}
              alt=""
              className="demo-checkout-store-logo"
              width={40}
              height={40}
            />
          ) : (
            <span className="demo-checkout-store-logo demo-checkout-store-logo-fallback" aria-hidden>
              {merchantName.trim().charAt(0).toUpperCase() || 'T'}
            </span>
          )}
          <div>
            <p className="demo-card-label">{eyebrow}</p>
            <h2 className="demo-checkout-title">{title}</h2>
          </div>
        </div>
        <div className="demo-checkout-card-actions">
          {testMode ? (
            <p
              className="demo-pay-test"
              role="note"
              title="Test mode — no real funds move."
            >
              Test
            </p>
          ) : null}
          {onClose ? (
            <button type="button" className="demo-checkout-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          ) : null}
        </div>
      </div>

      <div className="demo-status-hero" aria-hidden>
        {confirming ? (
          <div className="demo-status-orb">
            <span className="demo-status-ring" />
            <span className="demo-status-ring demo-status-ring-delay" />
            <span className="demo-status-core">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </div>
        ) : expired ? (
          <div className="demo-status-orb demo-status-orb-expired">
            <span className="demo-status-ring demo-status-ring-expired" />
            <span className="demo-status-ring demo-status-ring-delay demo-status-ring-expired" />
            <span className="demo-status-expired">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M12 7.5V12l3.2 2.1"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
        ) : (
          <div className="demo-status-check">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>

      <p className="demo-status-amount">{amountLabel}</p>
      <p className="demo-status-copy">{copy}</p>

      {confirming ? (
        <ol className="demo-status-ticks" aria-label="Confirmation progress">
          {tickLabels.map((label, i) => {
            // progress = completed count (1..3). Current pulse is at index progress (0-based).
            const isDone = i < progress || progress >= CONFIRM_STEPS;
            const isActive = !isDone && i === progress;
            return (
              <li
                key={label}
                data-done={isDone ? 'true' : 'false'}
                data-pulse={isActive ? 'true' : 'false'}
              >
                {i < CONFIRM_STEPS - 1 ? (
                  <span
                    className="demo-status-tick-link"
                    data-filled={i < progress ? 'true' : 'false'}
                    aria-hidden
                  />
                ) : null}
                <span className="demo-status-tick-dot" aria-hidden>
                  {isDone ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M5 13l4 4L19 7"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <span className="demo-status-tick-label">{label}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <button type="button" className="demo-status-cta" onClick={onContinue ?? onClose}>
          {expired
            ? skin === 'gaming'
              ? 'TRY AGAIN'
              : 'Start again'
            : skin === 'gaming'
              ? 'BACK TO GAME'
              : 'Continue'}
        </button>
      )}

      <p className="demo-checkout-footnote">
        <TendrLogo size={22} variant="color" tone={poweredByTone} />
        Powered by <strong>Tendr</strong>
      </p>
    </div>
  );
}
