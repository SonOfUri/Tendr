'use client';

// Theme success celebration. Confetti matches the demo “All set” burst.
// Nothing under `prefers-reduced-motion: reduce`. Decorative only.
import type { ThemeSettings } from '@tendr/contracts';
import { useEffect, useRef, useState } from 'react';
import { burstDemoConfetti } from '@/lib/demo/confetti';
import '@/components/demo/demo-confetti.css';

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Celebration({ kind }: { kind: ThemeSettings['celebration'] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (kind === 'none' || reducedMotion()) return;
    setOn(true);
  }, [kind]);

  useEffect(() => {
    if (!on || kind !== 'confetti' || !rootRef.current) return;
    return burstDemoConfetti(rootRef.current);
  }, [on, kind]);

  if (!on || kind === 'none') return null;
  return <div ref={rootRef} className="tdr-celebration" data-kind={kind} aria-hidden />;
}
