'use client';

import { useEffect, useState } from 'react';

/** Copies `value`; the button confirms "Copied" (announced politely). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button type="button" className="pay-copy" onClick={() => void copy()} aria-label={label}>
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy it' : 'Copy'}
      </span>
    </button>
  );
}
