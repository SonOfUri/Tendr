'use client';

import { useEffect, useRef } from 'react';
import type { DemoSlug } from '@/lib/demo';
import { TendrLogo } from '@/components/TendrLogo';

type Props = {
  variant: 'confirming' | 'success';
  skin: DemoSlug;
  merchantName: string;
  merchantLogoUrl: string;
  payEyebrow: string;
  amountLabel: string;
  successHint?: string;
  onContinue?: () => void;
  onClose?: () => void;
};

const CONFETTI_COLORS = ['#b6f34d', '#111111', '#ffffff', '#6ee7b7', '#93c5fd', '#fbbf24'];

function burstConfetti(root: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'demo-confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  const count = 64;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'demo-confetti-piece';
    piece.style.setProperty('--x', `${8 + Math.random() * 84}%`);
    piece.style.setProperty('--delay', `${Math.random() * 0.35}s`);
    piece.style.setProperty('--dur', `${1.4 + Math.random() * 1.2}s`);
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    piece.style.setProperty('--drift', `${Math.random() * 120 - 60}px`);
    piece.style.setProperty('--size', `${6 + Math.random() * 8}px`);
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
    layer.appendChild(piece);
  }
  root.appendChild(layer);
  window.setTimeout(() => layer.remove(), 3200);
}

export function DemoStatusCard({
  variant,
  skin,
  merchantName,
  merchantLogoUrl,
  payEyebrow,
  amountLabel,
  successHint,
  onContinue,
  onClose,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== 'success' || !shellRef.current) return;
    burstConfetti(shellRef.current);
  }, [variant]);

  const confirming = variant === 'confirming';

  return (
    <div
      ref={shellRef}
      className="demo-status-card"
      data-variant={variant}
      data-skin={skin}
      role="status"
      aria-live="polite"
      aria-label={confirming ? 'Confirming payment' : 'Payment complete'}
    >
      <div className="demo-status-card-top">
        <div className="demo-checkout-store">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={merchantLogoUrl}
            alt=""
            className="demo-checkout-store-logo"
            width={40}
            height={40}
          />
          <div>
            <p className="demo-card-label">
              {confirming ? `${payEyebrow} ${merchantName}` : merchantName}
            </p>
            <h2 className="demo-checkout-title">
              {confirming ? (skin === 'gaming' ? 'SYNCING…' : 'Confirming') : skin === 'gaming' ? 'UNLOCKED' : 'All set'}
            </h2>
          </div>
        </div>
        {onClose ? (
          <button type="button" className="demo-checkout-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        ) : null}
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
      <p className="demo-status-copy">
        {confirming
          ? skin === 'gaming'
            ? 'Loot detected — confirming on-chain…'
            : 'Payment detected — confirming on-chain…'
          : successHint ?? 'Payment complete. You’re good to go.'}
      </p>

      {confirming ? (
        <ul className="demo-status-ticks">
          <li data-done="true">{skin === 'gaming' ? 'Payment received' : 'Payment detected'}</li>
          <li data-pulse="true">{skin === 'gaming' ? 'Minting unlock' : 'Confirming on-chain'}</li>
          <li>{skin === 'gaming' ? 'Inventory sync' : 'Settlement'}</li>
        </ul>
      ) : (
        <button type="button" className="demo-status-cta" onClick={onContinue}>
          {skin === 'gaming' ? 'BACK TO GAME' : 'Continue'}
        </button>
      )}

      <p className="demo-checkout-footnote">
        <TendrLogo size={22} />
        Powered by <strong>Tendr</strong>
      </p>
    </div>
  );
}
