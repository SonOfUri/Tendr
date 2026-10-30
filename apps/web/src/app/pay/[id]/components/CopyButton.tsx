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
    <span className="pay-copy-wrap">
      <button type="button" className="pay-copy" onClick={() => void copy()} aria-label={label}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {/* Outside the button: a live region inside a labelled button is not announced. */}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Copy failed. Select it and copy it.'
            : ''}
      </span>
      {state === 'failed' ? (
        <span className="pay-error small" aria-hidden>
          Select and copy it
        </span>
      ) : null}
    </span>
  );
}
