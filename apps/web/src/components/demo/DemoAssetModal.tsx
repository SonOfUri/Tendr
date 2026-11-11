'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DEMO_CHAIN_STACK_MAX,
  isMultiChain,
  optionMatchesAssetId,
  variantForAssetId,
  type DemoAssetOption,
  type DemoChainVariant,
} from '@/lib/demo-assets';
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

const DESKTOP_CHAIN_MQ = '(min-width: 721px)';

function AssetIcon({ src, label }: { src: string; label: string }) {
  const letter = (label.replace(/^\$/, '').trim()[0] ?? '?').toUpperCase();
  if (!src) {
    return (
      <span className="demo-asset-row-icon demo-asset-row-icon-fallback" aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className="demo-asset-row-icon"
      width={36}
      height={36}
      onError={(e) => {
        const img = e.currentTarget;
        const span = document.createElement('span');
        span.className = 'demo-asset-row-icon demo-asset-row-icon-fallback';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = letter;
        img.replaceWith(span);
      }}
    />
  );
}

function ChainStack({
  option,
  panelOpen,
  onOpenNetworks,
}: {
  option: DemoAssetOption;
  panelOpen?: boolean;
  onOpenNetworks?: () => void;
}) {
  const logos = option.chainLogos.filter((c) => c.logoSrc);
  if (logos.length === 0) {
    return <span className="demo-asset-row-detail">{option.detail}</span>;
  }

  const multi = isMultiChain(option);
  const shown = logos.slice(0, DEMO_CHAIN_STACK_MAX);
  const extra = logos.length - shown.length;
  const names = option.chainLogos.map((c) => c.name).join(', ');
  const overflow = extra > 0;

  return (
    <span
      className="demo-asset-chain-stack"
      data-multi={multi ? 'true' : 'false'}
      title={multi ? undefined : names}
      aria-label={names}
    >
      {shown.map((chain, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={chain.id}
          src={chain.logoSrc}
          alt=""
          className="demo-asset-chain-logo"
          width={26}
          height={26}
          style={{ zIndex: shown.length - i }}
          onError={(e) => {
            e.currentTarget.remove();
          }}
        />
      ))}
      {overflow ? (
        // span — not button: this sits inside the asset row <button> (no nested buttons).
        <span
          role="button"
          tabIndex={0}
          className="demo-asset-chain-more"
          aria-expanded={panelOpen}
          aria-label={`Show all ${option.chainVariants.length} chains`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenNetworks?.();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onOpenNetworks?.();
          }}
        >
          +{extra} {extra === 1 ? 'Chain' : 'Chains'}
        </span>
      ) : multi ? (
        <span
          role="button"
          tabIndex={0}
          className="demo-asset-chain-more"
          aria-expanded={panelOpen}
          aria-label={`Choose network for ${option.label}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenNetworks?.();
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            onOpenNetworks?.();
          }}
        >
          {option.chainVariants.length} Chains
        </span>
      ) : null}
    </span>
  );
}

function ChainPickerPanel({
  option,
  value,
  onPick,
  onMouseEnter,
  onMouseLeave,
}: {
  option: DemoAssetOption;
  value: string;
  onPick: (variant: DemoChainVariant) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <div
      className="demo-asset-chain-panel"
      role="listbox"
      aria-label={`${option.label} networks`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="demo-asset-chain-panel-head">
        <span className="demo-asset-chain-panel-title">{option.label}</span>
        <span className="demo-asset-chain-panel-sub">
          {option.chainVariants.length} networks · pick where you’ll deposit
        </span>
      </div>
      <ul className="demo-asset-chain-panel-list">
        {option.chainVariants.map((variant) => {
          const active = variant.assetId === value;
          return (
            <li key={variant.assetId}>
              <button
                type="button"
                className="demo-asset-chain-panel-row"
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : 'false'}
                onClick={() => onPick(variant)}
              >
                {variant.logoSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={variant.logoSrc}
                    alt=""
                    className="demo-asset-chain-panel-logo"
                    width={28}
                    height={28}
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <span className="demo-asset-chain-panel-logo demo-asset-chain-panel-logo-fallback" aria-hidden>
                    {(variant.name[0] ?? '?').toUpperCase()}
                  </span>
                )}
                <span className="demo-asset-chain-panel-copy">
                  <span className="demo-asset-chain-panel-name">{variant.name}</span>
                </span>
                {active ? <span className="demo-asset-chain-panel-check">✓</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function useDesktopChainLayout() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_CHAIN_MQ);
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return desktop;
}

export function DemoAssetModal({
  options,
  value,
  disabled,
  skin,
  onChange,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const clearHoverTimer = useRef<number | null>(null);
  const titleId = useId();
  const desktop = useDesktopChainLayout();
  const selected =
    options.find((o) => optionMatchesAssetId(o, value)) ?? options.find((o) => o.token);
  const selectedVariant = selected ? variantForAssetId(selected, value) : undefined;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) {
      setHoverKey(null);
      setPinnedKey(null);
      setAnchorRect(null);
      return;
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pinnedKey || hoverKey) {
          setPinnedKey(null);
          setHoverKey(null);
          return;
        }
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, pinnedKey, hoverKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.detail.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        o.chainVariants.some(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.blockchain.toLowerCase().includes(q) ||
            c.assetId.toLowerCase().includes(q),
        ),
    );
  }, [options, query]);

  const sideKey = pinnedKey ?? hoverKey;
  const sideOption =
    sideKey != null ? filtered.find((o) => o.value === sideKey && isMultiChain(o)) : undefined;

  useLayoutEffect(() => {
    if (!sideOption || !desktop) {
      setAnchorRect(null);
      return;
    }
    const el = rowRefs.current.get(sideOption.value);
    if (!el) {
      setAnchorRect(null);
      return;
    }
    const sync = () => setAnchorRect(el.getBoundingClientRect());
    sync();
    const list = listRef.current;
    list?.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    return () => {
      list?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
    };
  }, [sideOption, desktop, filtered]);

  function clearHoverSoon() {
    if (clearHoverTimer.current) window.clearTimeout(clearHoverTimer.current);
    clearHoverTimer.current = window.setTimeout(() => {
      if (!pinnedKey) setHoverKey(null);
    }, 120);
  }

  function keepHover(key: string) {
    if (clearHoverTimer.current) window.clearTimeout(clearHoverTimer.current);
    setHoverKey(key);
  }

  function close() {
    setOpen(false);
    setQuery('');
    setHoverKey(null);
    setPinnedKey(null);
    setAnchorRect(null);
  }

  function pickAsset(assetId: string) {
    onChange(assetId);
    close();
  }

  const portalTarget =
    typeof document !== 'undefined'
      ? document.querySelector('.demo-playground') ??
        document.querySelector('.hosted-pay-page') ??
        document.querySelector('.invoice-portal') ??
        document.body
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

              <ul ref={listRef} className="demo-asset-list" role="listbox" aria-label="Assets">
                {filtered.length === 0 ? (
                  <li className="demo-asset-empty">No assets match “{query.trim()}”.</li>
                ) : (
                  filtered.map((opt) => {
                    const active = optionMatchesAssetId(opt, value);
                    const multi = isMultiChain(opt);
                    const panelOpen = multi && sideKey === opt.value;
                    return (
                      <li
                        key={opt.value}
                        className="demo-asset-row-wrap"
                        ref={(node) => {
                          if (node) rowRefs.current.set(opt.value, node);
                          else rowRefs.current.delete(opt.value);
                        }}
                        onMouseEnter={() => {
                          if (multi) keepHover(opt.value);
                          else if (!pinnedKey) setHoverKey(null);
                        }}
                        onMouseLeave={() => {
                          if (desktop) clearHoverSoon();
                          else if (!pinnedKey && hoverKey === opt.value) setHoverKey(null);
                        }}
                      >
                        <button
                          type="button"
                          className="demo-asset-row"
                          role="option"
                          aria-selected={active}
                          data-active={active ? 'true' : 'false'}
                          data-disabled={opt.disabled ? 'true' : 'false'}
                          disabled={opt.disabled}
                          onClick={() => {
                            if (opt.disabled) return;
                            // Multi-chain assets need an explicit network — deposit address differs per chain.
                            if (multi) {
                              setPinnedKey((k) => (k === opt.value ? null : opt.value));
                              setHoverKey(opt.value);
                              return;
                            }
                            pickAsset(opt.value);
                          }}
                        >
                          <AssetIcon src={opt.iconSrc} label={opt.label} />
                          <span className="demo-asset-row-copy">
                            <span className="demo-asset-row-name-row">
                              <span className="demo-asset-row-name">{opt.label}</span>
                            </span>
                            <ChainStack
                              option={opt}
                              panelOpen={panelOpen}
                              onOpenNetworks={() => {
                                if (!multi) return;
                                setPinnedKey((k) => (k === opt.value ? null : opt.value));
                                setHoverKey(opt.value);
                              }}
                            />
                          </span>
                        </button>
                        {!desktop && panelOpen ? (
                          <div className="demo-asset-chain-inline">
                            <ChainPickerPanel
                              option={opt}
                              value={value}
                              onPick={(variant) => pickAsset(variant.assetId)}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
            {desktop && sideOption && anchorRect ? (
              <aside
                className="demo-asset-chain-float"
                data-skin={skin}
                style={{
                  top: Math.min(
                    Math.max(12, anchorRect.top),
                    window.innerHeight - 24 - Math.min(420, window.innerHeight * 0.7),
                  ),
                  left: Math.min(anchorRect.right + 10, window.innerWidth - 300 - 12),
                }}
              >
                <ChainPickerPanel
                  option={sideOption}
                  value={value}
                  onPick={(variant) => pickAsset(variant.assetId)}
                  onMouseEnter={() => keepHover(sideOption.value)}
                  onMouseLeave={clearHoverSoon}
                />
              </aside>
            ) : null}
          </div>,
          portalTarget,
        )
      : null;

  const triggerDetail = selectedVariant
    ? selectedVariant.name
    : selected && selected.chainVariants.length <= 1
      ? selected.detail
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
            {selected ? (
              <AssetIcon src={selected.iconSrc} label={selected.label} />
            ) : (
              <span className="demo-dd-icon demo-dd-icon-fallback" aria-hidden />
            )}
            <span className="demo-dd-value-text">
              <span className="demo-dd-value-main">{selected?.label ?? 'Select asset'}</span>
              {selectedVariant?.logoSrc ? (
                <span className="demo-asset-chain-stack demo-asset-chain-stack-selected">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedVariant.logoSrc}
                    alt=""
                    className="demo-asset-chain-logo"
                    width={22}
                    height={22}
                  />
                  <span className="demo-dd-value-detail">{selectedVariant.name}</span>
                </span>
              ) : selected ? (
                triggerDetail ? (
                  <span className="demo-dd-value-detail">{triggerDetail}</span>
                ) : (
                  <ChainStack option={selected} />
                )
              ) : null}
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
