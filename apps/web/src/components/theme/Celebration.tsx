'use client';

// The theme's success celebration: confetti or a pulse, once, when the thank-you page appears.
// Nothing at all under `prefers-reduced-motion: reduce`. Decorative only: hidden from screen
// readers and never in the way of a tap.
import type { ThemeSettings } from '@tendr/contracts';
import { useEffect, useState, type CSSProperties } from 'react';

const DURATION_MS = 2600;
const PIECES = 28;

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Celebration({ kind }: { kind: ThemeSettings['celebration'] }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (kind === 'none' || reducedMotion()) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), DURATION_MS);
    return () => clearTimeout(t);
  }, [kind]);

  if (!on || kind === 'none') return null;
  return (
    <div className="tdr-celebration" data-kind={kind} aria-hidden>
      {kind === 'confetti'
        ? Array.from({ length: PIECES }, (_, i) => (
            <span
              key={i}
              className="tdr-confetti-piece"
              style={
                {
                  left: `${((i * 37) % 100) + 0.5}%`,
                  animationDelay: `${(i % 7) * 70}ms`,
                  '--tdr-confetti-turn': `${(i % 2 ? 1 : -1) * (180 + ((i * 53) % 360))}deg`,
                } as CSSProperties
              }
            />
          ))
        : null}
    </div>
  );
}
