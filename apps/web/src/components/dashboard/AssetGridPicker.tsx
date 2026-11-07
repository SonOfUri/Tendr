'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import type { SelectOption } from './Select';

/** Closed control matches the dashboard dropdown. Opening it shows a centered logo grid. */
export function AssetGridPicker({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  disabled = false,
  placeholder = 'Choose',
  className = '',
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const heading = title ?? ariaLabel;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  const modal =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div className="dash-asset-layer" role="presentation" onMouseDown={() => setOpen(false)}>
          <div
            className="dash-asset-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dash-asset-modal-bar">
              <h2 id={titleId}>{heading}</h2>
              <button type="button" className="dash-asset-modal-close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={18} strokeWidth={1.75} />
              </button>
            </header>
            <label className="dash-asset-search">
              <Search size={16} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">Search</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search"
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {filtered.length === 0 ? (
              <p className="dash-asset-empty">Nothing matches that search.</p>
            ) : (
              <div className="dash-asset-grid" role="listbox" aria-label={ariaLabel}>
                {filtered.map((option) => {
                  const isSelected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className="dash-asset-tile"
                      data-selected={isSelected ? 'true' : 'false'}
                      disabled={option.disabled}
                      onClick={() => {
                        if (!option.disabled) choose(option.value);
                      }}
                    >
                      <span className="dash-asset-tile-logo">{option.icon}</span>
                      <span className="dash-asset-tile-name">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`tendr-select tendr-select--field ${className}`.trim()} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="tendr-select-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {selected?.icon ? <span className="tendr-select-leading">{selected.icon}</span> : null}
        <span className="tendr-select-label">{selected?.label ?? placeholder}</span>
        <span className="tendr-select-chevron" aria-hidden>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      {modal}
    </div>
  );
}
