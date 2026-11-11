'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DemoAssetOption } from '@/lib/demo-assets';
import { buildTendrAiRoutes, type TendrAiRoute } from '@/lib/demo-tendr-ai';
import {
  demoTendrAiHelp,
  TENDR_AI_SUGGESTIONS,
  type TendrAiHelpReply,
} from '@/lib/demo-tendr-ai-help';
import type { DemoSlug } from '@/lib/demo';
import { TendrAiGhost } from './TendrAiGhost';

type Props = {
  options: DemoAssetOption[];
  amountLabel: string;
  skin?: DemoSlug;
  onPickRoute: (assetId: string) => void;
};

type HelpPhase =
  | { k: 'idle' }
  | { k: 'loading' }
  | { k: 'answer'; data: TendrAiHelpReply };

export function DemoTendrAiFab({ options, amountLabel, skin, onPickRoute }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'routes' | 'help'>('routes');
  const [thinking, setThinking] = useState(false);
  const [help, setHelp] = useState<HelpPhase>({ k: 'idle' });
  const [question, setQuestion] = useState('');
  const [mounted, setMounted] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const helpReq = useRef(0);

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
      setHelp({ k: 'idle' });
      setQuestion('');
      setTab('routes');
      return;
    }
    if (tab !== 'routes') {
      setThinking(false);
      return;
    }
    setThinking(true);
    const t = window.setTimeout(() => setThinking(false), 1800);
    return () => window.clearTimeout(t);
  }, [open, tab]);

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

  function ask(q: string) {
    const trimmed = q.trim().slice(0, 1000);
    if (!trimmed || help.k === 'loading') return;
    const id = ++helpReq.current;
    setHelp({ k: 'loading' });
    window.setTimeout(() => {
      if (id !== helpReq.current) return;
      setHelp({ k: 'answer', data: demoTendrAiHelp(trimmed) });
    }, 900);
  }

  if (!mounted || routes.length === 0) return null;

  const gaming = skin === 'gaming';
  const amount = amountLabel.replace(/^\$/, '').replace(/\.00$/, '');
  const busy = thinking || help.k === 'loading';

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
          aria-label="Tendr AI"
        >
          <div className="demo-tendrai-intro">
            <TendrAiGhost thinking={busy} size={44} />
            <div className="demo-tendrai-intro-copy">
              <span className="demo-tendrai-kicker">Tendr AI</span>
              <p>
                {busy
                  ? 'Working…'
                  : tab === 'routes'
                    ? `Route ideas for $${amount}.`
                    : 'Ask about this checkout.'}
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

          <div className="checkout-ai-tabs" role="tablist" aria-label="Tendr AI mode">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'routes'}
              className="checkout-ai-tab"
              onClick={() => setTab('routes')}
            >
              Routes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'help'}
              className="checkout-ai-tab"
              onClick={() => setTab('help')}
            >
              Help
            </button>
          </div>

          {tab === 'routes' && !thinking ? (
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

          {tab === 'help' ? (
            <div className="checkout-ai-help">
              {help.k === 'answer' ? (
                <div className="checkout-ai-answer">
                  <p>{help.data.answer}</p>
                  {help.data.facts.length > 0 ? (
                    <ul>
                      {help.data.facts.map((f) => (
                        <li key={f.id}>{f.text}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="checkout-ai-suggestions">
                {TENDR_AI_SUGGESTIONS.map((s) => (
                  <button key={s} type="button" disabled={busy} onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
              <form
                className="checkout-ai-ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  ask(question);
                }}
              >
                <input
                  value={question}
                  maxLength={1000}
                  disabled={busy}
                  placeholder="Ask about this payment"
                  aria-label="Ask Tendr AI"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" disabled={busy || !question.trim()}>
                  Ask
                </button>
              </form>
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
        <TendrAiGhost thinking={open && busy} size={36} />
        <span className="demo-tendrai-fab-label">{gaming ? 'AI' : 'Tendr AI'}</span>
      </button>
    </div>,
    document.querySelector('.demo-playground') ?? document.body,
  );
}
