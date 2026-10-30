'use client';

// The phone pay bar: when a theme puts tall content above the payment block, a bar fixed to the
// bottom of the screen shows the amount and the payee, and one tap brings the payment block into
// view. Shown only on viewports ≤ 640 px while less than 30% of the sealed payment block is on
// screen. It is Tendr's own element (outside every merchant block): merchant CSS can neither
// match it nor use `position: fixed` (the API refuses it), so nothing a theme draws sits above it.
import { useEffect, useState } from 'react';

const PHONE = '(max-width: 640px)';
/** Below this share of the payment block on screen, the bar shows. */
const MIN_VISIBLE = 0.3;
const THRESHOLDS = Array.from({ length: 51 }, (_, i) => i / 50);

/**
 * How much of the element is on screen, 0–1: of its own height, or of the screen's height when it
 * is taller than the screen (a payment block taller than a phone counts as fully seen when it
 * fills the screen).
 */
export function visibleShare(entry: IntersectionObserverEntry): number {
  const own = entry.boundingClientRect.height;
  const screen =
    entry.rootBounds?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  const base = Math.min(own, screen > 0 ? screen : own);
  if (base <= 0) return entry.isIntersecting ? 1 : 0;
  return Math.min(1, entry.intersectionRect.height / base);
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return phone;
}

export function PayBar({
  amount,
  payee,
  target,
  onActivate,
}: {
  /** The order total, as the payment block shows it. */
  amount: string;
  /** The account being paid (never the theme's display name). */
  payee: string;
  /** The sealed payment block the bar stands in for. */
  target: () => Element | null;
  /** Scrolls the payment block into view and focuses its first control. */
  onActivate: () => void;
}) {
  const phone = usePhone();
  const [offscreen, setOffscreen] = useState(false);

  useEffect(() => {
    const el = target();
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setOffscreen(visibleShare(last) < MIN_VISIBLE);
      },
      { threshold: THRESHOLDS },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target]);

  if (!phone || !offscreen) return null;
  return (
    <div className="tdr-pay-bar" data-pay-bar="">
      <button
        type="button"
        className="tdr-pay-bar-button"
        onClick={() => {
          // Hidden right away; the observer brings it back if the shopper scrolls away again.
          setOffscreen(false);
          onActivate();
        }}
      >
        <span className="tdr-pay-bar-text">
          <strong className="tdr-pay-bar-amount">{amount}</strong>
          <span className="tdr-pay-bar-payee">You&apos;re paying {payee}</span>
        </span>
        <span className="tdr-pay-bar-action" aria-hidden>
          Pay ↓
        </span>
      </button>
    </div>
  );
}

/** The first control in the payment block, focused after the bar scrolls it into view. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Brings `section` into view (instantly under reduced motion) and focuses its first control. */
export function revealPayment(section: Element | null): void {
  if (!section) return;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (section as HTMLElement).scrollIntoView?.({
    block: 'start',
    behavior: reduced ? 'auto' : 'smooth',
  });
  const first = section.querySelector<HTMLElement>(FOCUSABLE);
  first?.focus({ preventScroll: true });
}
