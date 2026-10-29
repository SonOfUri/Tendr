'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DemoAssetOption } from '@/lib/demo-assets';
import type { DemoSlug } from '@/lib/demo';

type Props = {
  options: DemoAssetOption[];
  value: string;
  disabled?: boolean;
  skin?: DemoSlug;
  onChange: (value: string) => void;
  /** Lets the checkout demo timer pause while the picker is open. */
  onOpenChange?: (open: boolean) => void;
};

export function DemoAssetModal({ options, value, disabled, skin, onChange, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const selected = options.find((o) => o.value === value) ?? options.find((o) => o.token);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.detail.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  // Portal into .demo-playground so --demo-* theme vars apply (they are scoped there, not on body).
  const portalTarget =
    typeof document !== 'undefined'
      ? document.querySelector('.demo-playground') ?? document.body
      : null;

  const gaming = skin === 'gaming';
  const title = gaming ? 'SELECT ASSET' : 'Select asset';
  const searchPlaceholder = gaming ? 'SEARCH NAME / SYMBOL' : 'Search name or symbol';

  const modal =
    mounted && open && portalTarget
      ? createPortal(
          <div className="demo-asset-layer" data-skin={skin} role="presentation">
            <button type="button" className="demo-asset-backdrop" aria-label="Close" onClick={close} />
            <div
              className="demo-asset-modal"
              data-skin={skin}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <div className="demo-asset-modal-top">
                <h3 id={titleId}>{title}</h3>
                <button type="button" className="demo-asset-modal-close" aria-label="Close" onClick={close}>
                  ×
                </button>
              </div>

              <label className="demo-asset-search">
                <span className="sr-only">Search assets</span>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  ref={inputRef}
                  type="search"
                  placeholder={searchPlaceholder}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                />
              </label>

              <ul className="demo-asset-list" role="listbox" aria-label="Assets">
                {filtered.length === 0 ? (
                  <li className="demo-asset-empty">No assets match “{query.trim()}”.</li>
                ) : (
                  filtered.map((opt) => (
                    <li key={opt.value}>
                      <button
                        type="button"
                        className="demo-asset-row"
                        role="option"
                        aria-selected={opt.value === value}
                        data-active={opt.value === value ? 'true' : 'false'}
                        data-disabled={opt.disabled ? 'true' : 'false'}
                        disabled={opt.disabled}
                        onClick={() => {
                          if (opt.disabled) return;
                          onChange(opt.value);
                          close();
                        }}
                      >
                        {opt.iconSrc ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={opt.iconSrc} alt="" className="demo-asset-row-icon" width={36} height={36} />
                        ) : (
                          <span className="demo-asset-row-icon demo-asset-row-icon-fallback" aria-hidden />
                        )}
                        <span className="demo-asset-row-copy">
                          <span className="demo-asset-row-name">{opt.label}</span>
                          <span className="demo-asset-row-detail">{opt.detail}</span>
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>,
          portalTarget,
        )
      : null;

  return (
    <>
      <div className="demo-asset-field">
        <span className="demo-dd-label">{gaming ? 'ASSET' : 'Asset'}</span>
        <button
          type="button"
          className="demo-asset-trigger"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="demo-asset-trigger-main">
            {selected?.iconSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selected.iconSrc} alt="" className="demo-dd-icon" width={28} height={28} />
            ) : (
              <span className="demo-dd-icon demo-dd-icon-fallback" aria-hidden />
            )}
            <span className="demo-dd-value-text">
              <span className="demo-dd-value-main">{selected?.label ?? 'Select asset'}</span>
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
      </div>
      {modal}
    </>
  );
}
