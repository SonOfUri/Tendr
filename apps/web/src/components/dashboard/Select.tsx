'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Shown beside the label in the menu and on the closed control. */
  icon?: ReactNode;
};

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  /** Leading icon inside the trigger */
  leading?: ReactNode;
  /** Compact pill style used in the dashboard header */
  variant?: 'default' | 'pill';
  disabled?: boolean;
  placeholder?: string;
};

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  triggerClassName = '',
  menuClassName = '',
  leading,
  variant = 'default',
  disabled = false,
  placeholder = 'Select…',
}: SelectProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
  }, [open, options, value]);

  function commit(next: string) {
    onChange(next);
    close();
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKey(e: KeyboardEvent<HTMLUListElement>) {
    const enabled = options
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !o.disabled);
    if (enabled.length === 0) return;

    const idxInEnabled = Math.max(
      0,
      enabled.findIndex(({ i }) => i === active),
    );

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = enabled[(idxInEnabled + 1) % enabled.length]!;
      setActive(next.i);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = enabled[(idxInEnabled - 1 + enabled.length) % enabled.length]!;
      setActive(next.i);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabled[0]!.i);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabled[enabled.length - 1]!.i);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[active];
      if (opt && !opt.disabled) commit(opt.value);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      close();
    }
  }

  return (
    <div
      ref={rootRef}
      className={`tendr-select tendr-select--${variant} ${className}`.trim()}
      data-open={open ? 'true' : 'false'}
    >
      <button
        type="button"
        className={`tendr-select-trigger ${triggerClassName}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        {leading || selected?.icon ? (
          <span className="tendr-select-leading">{leading ?? selected?.icon}</span>
        ) : null}
        <span className="tendr-select-label">{label}</span>
        <span className="tendr-select-chevron" aria-hidden>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>

      {open ? (
        <ul
          id={listId}
          className={`tendr-select-menu ${menuClassName}`.trim()}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          ref={(el) => el?.focus()}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            return (
              <li
                key={opt.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                className="tendr-select-option"
                data-active={i === active ? 'true' : 'false'}
                data-selected={isSelected ? 'true' : 'false'}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  if (!opt.disabled) commit(opt.value);
                }}
              >
                {opt.icon ? <span className="tendr-select-option-icon">{opt.icon}</span> : null}
                <span className="tendr-select-option-label">{opt.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
