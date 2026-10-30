'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DemoAssetOption } from '@/lib/demo-assets';
import { buildTendrAiRoutes, type TendrAiRoute } from '@/lib/demo-tendr-ai';
import type { DemoSlug } from '@/lib/demo';
import { TendrAiGhost } from './TendrAiGhost';

type Props = {
  options: DemoAssetOption[];
  amountLabel: string;
  skin?: DemoSlug;
  onPickRoute: (assetId: string) => void;
};

export function DemoTendrAiFab({ options, amountLabel, skin, onPickRoute }: Props) {
  const [open, setOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const ai = useMemo(() => buildTendrAiRoutes(options), [options]);
  const routes = useMemo(() => {
    const list: TendrAiRoute[] = [];
    for (const kind of ['recommended', 'cheapest', 'fastest'] as const) {
      const r = ai[kind];
      if (r) list.push(r);
    }
    return list;
  }, [ai]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) {
      setThinking(false);
      return;
    }
    setThinking(true);
    const t = window.setTimeout(() => setThinking(false), 3000);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  if (!mounted || routes.length === 0) return null;

  const gaming = skin === 'gaming';
  const amount = amountLabel.replace(/^\$/, '').replace(/\.00$/, '');

  return createPortal(
    <div
      ref={rootRef}
      className="demo-tendrai-fab-root"
      data-skin={skin}
      data-open={open ? 'true' : 'false'}
    >
      {open ? (
        <section
          id={panelId}
          className="demo-tendrai demo-tendrai-panel"
          aria-label="Tendr AI route suggestions"
        >
          <div className="demo-tendrai-intro">
            <TendrAiGhost thinking={thinking} size={44} />
            <div className="demo-tendrai-intro-copy">
              <span className="demo-tendrai-kicker">Tendr AI</span>
              <p>
                {thinking
                  ? 'Ghost is scoring rails for this payment…'
                  : `Picked routes for $${amount}.`}
              </p>
            </div>
            <button
              type="button"
              className="demo-tendrai-panel-close"
              aria-label="Close Tendr AI"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          {!thinking ? (
            <div className="demo-tendrai-cards" role="list">
              {routes.map((route) => (
                <button
                  key={route.kind}
                  type="button"
                  className="demo-tendrai-card"
                  data-kind={route.kind}
                  role="listitem"
                  onClick={() => {
                    onPickRoute(route.assetId);
                    setOpen(false);
                  }}
                >
                  <span className="demo-tendrai-card-top">
                    <span className="demo-tendrai-card-kind">{route.title}</span>
                    <span className="demo-tendrai-card-eta">{route.eta}</span>
                  </span>
                  <span className="demo-tendrai-card-asset">
                    {route.iconSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={route.iconSrc} alt="" width={22} height={22} />
                    ) : null}
                    <span>{route.symbol}</span>
                    {route.chainLogoSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={route.chainLogoSrc}
                        alt=""
                        className="demo-tendrai-card-chain"
                        width={16}
                        height={16}
                      />
                    ) : null}
                    <span className="demo-tendrai-card-chain-name">{route.chainName}</span>
                  </span>
                  <span className="demo-tendrai-card-meta">
                    {route.feeHint} · tap to pay this rail
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <button
        type="button"
        className="demo-tendrai-fab"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={gaming ? 'TENDR AI' : 'Open Tendr AI'}
        onClick={() => setOpen((v) => !v)}
      >
        <TendrAiGhost thinking={open && thinking} size={36} />
        <span className="demo-tendrai-fab-label">{gaming ? 'AI' : 'Tendr AI'}</span>
      </button>
    </div>,
    document.querySelector('.demo-playground') ?? document.body,
  );
}
