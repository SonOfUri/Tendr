'use client';

import { formatCountdown } from '@/lib/checkout/format';

/**
 * Time left until `deadline`. The ticking m:ss is hidden from screen readers; a polite live region
 * announces the time once a minute (and when it runs out), so it is not read every second.
 */
export function Countdown({
  deadline,
  now,
  label,
  announceUnderMs = Infinity,
}: {
  deadline: string;
  now: number;
  /** What the time is for, e.g. "on this price". */
  label: string;
  /** Announce only once less than this is left (default: always, once a minute). */
  announceUnderMs?: number;
}) {
  const left = Date.parse(deadline) - now;
  const minutes = Math.floor(left / 60_000);
  const spoken =
    left > announceUnderMs
      ? ''
      : left <= 0
        ? `Time is up ${label}`
        : minutes < 1
          ? `Less than a minute left ${label}`
          : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left ${label}`;
  return (
    <span className="pay-countdown">
      <span aria-hidden>⏱ {formatCountdown(left)}</span>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </span>
  );
}
