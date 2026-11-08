'use client';

import { Info } from 'lucide-react';
import { useId, useState } from 'react';

/** Compact “i” control that shows the full value on hover/focus (and as native title). */
export function InfoTip({ text, label = 'Full amount' }: { text: string; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="dash-info-tip">
      <button
        type="button"
        className="dash-info-tip-btn"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        title={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Info size={14} strokeWidth={2.1} aria-hidden />
      </button>
      {open ? (
        <span id={id} role="tooltip" className="dash-info-tip-bubble">
          {text}
        </span>
      ) : null}
    </span>
  );
}
