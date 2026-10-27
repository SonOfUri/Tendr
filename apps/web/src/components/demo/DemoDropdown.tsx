'use client';

import { useEffect, useId, useRef, useState } from 'react';

export type DemoDropdownOption<T extends string> = {
  value: T;
  label: string;
  detail?: string;
  iconSrc?: string;
  disabled?: boolean;
};

type Props<T extends string> = {
  label: string;
  value: T;
  options: DemoDropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Hide the floating field label above the control */
  hideLabel?: boolean;
};

export function DemoDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hideLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="demo-dd" ref={rootRef} data-open={open ? 'true' : 'false'}>
      {hideLabel ? null : <span className="demo-dd-label">{label}</span>}
      <button
        type="button"
        className="demo-dd-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="demo-dd-value">
          {selected?.iconSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.iconSrc} alt="" className="demo-dd-icon" width={22} height={22} />
          ) : null}
          <span className="demo-dd-value-text">
            <span className="demo-dd-value-main">{selected?.label}</span>
            {selected?.detail ? <span className="demo-dd-value-detail">{selected.detail}</span> : null}
          </span>
        </span>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M4 6.5 8 10.5 12 6.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>
      {open ? (
        <ul className="demo-dd-menu" id={listId} role="listbox" aria-label={label}>
          {options.map((opt) => (
            <li key={opt.value} role="option" aria-selected={opt.value === value} aria-disabled={opt.disabled || undefined}>
              <button
                type="button"
                className="demo-dd-option"
                data-active={opt.value === value ? 'true' : 'false'}
                data-disabled={opt.disabled ? 'true' : 'false'}
                disabled={opt.disabled}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="demo-dd-option-main">
                  {opt.iconSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={opt.iconSrc} alt="" className="demo-dd-icon" width={22} height={22} />
                  ) : (
                    <span className="demo-dd-icon demo-dd-icon-fallback" aria-hidden />
                  )}
                  <span>{opt.label}</span>
                </span>
                {opt.detail ? <span className="demo-dd-option-detail">{opt.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
