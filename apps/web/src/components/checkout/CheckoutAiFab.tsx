'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssistantAnswer, RouteRecommendations } from '@tendr/contracts';
import { CheckoutApiError, type CheckoutClient } from '@/lib/checkout/api';
import { networkName } from '@/lib/checkout/format';
import { chainLogo } from '@/lib/chain-logos';
import {
  optionMatchesAssetId,
  variantForAssetId,
  type DemoAssetOption,
} from '@/lib/demo-assets';
import { TENDR_AI_SUGGESTIONS } from '@/lib/demo-tendr-ai-help';
import { TendrAiGhost } from '@/components/demo/TendrAiGhost';
import '@/components/demo/demo-playground.css';

function routeVisuals(options: DemoAssetOption[], assetId: string, chain: string) {
  const option = options.find((o) => optionMatchesAssetId(o, assetId));
  const variant = option ? variantForAssetId(option, assetId) : undefined;
  const chainMeta = chainLogo(variant?.blockchain ?? chain);
  return {
    iconSrc: option?.iconSrc || variant?.token.logo_url || '',
    chainLogoSrc: variant?.logoSrc || chainMeta.logoSrc,
    chainName: variant?.name || chainMeta.name || networkName(chain),
  };
}

type Props = {
  client: CheckoutClient;
  sessionId: string;
  options: DemoAssetOption[];
  amountLabel: string;
  onPickRoute: (assetId: string) => void;
};

type Phase =
  | { k: 'idle' }
  | { k: 'loading' }
  | { k: 'routes'; data: RouteRecommendations }
  | { k: 'help'; data: AssistantAnswer }
  | { k: 'empty' }
  | { k: 'rate' }
  | { k: 'unavailable'; message: string };

function errPhase(err: unknown): Phase {
  if (err instanceof CheckoutApiError) {
    if (err.status === 429 || err.code === 'RATE_LIMITED') return { k: 'rate' };
    if (
      err.status === 503 ||
      err.code === 'PROVIDER_NOT_CONFIGURED' ||
      err.code === 'PROVIDER_UNAVAILABLE'
    ) {
      return { k: 'unavailable', message: 'Tendr AI is unavailable right now.' };
    }
    return { k: 'unavailable', message: err.message || 'Tendr AI could not answer.' };
  }
  return { k: 'unavailable', message: 'Tendr AI could not answer.' };
}

export function CheckoutAiFab({ client, sessionId, options, amountLabel, onPickRoute }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'routes' | 'help'>('routes');
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [question, setQuestion] = useState('');
  const [mounted, setMounted] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const req = useRef(0);

  const assetPayload = useMemo(
    () =>
      options
        .filter((o) => o.token)
        .slice(0, 4)
        .map((o) => ({ asset_id: o.token!.asset_id })),
    [options],
  );

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setPhase({ k: 'idle' });
    setQuestion('');
  }, [sessionId]);

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

  async function loadRoutes() {
    if (assetPayload.length === 0) {
      setPhase({ k: 'empty' });
      return;
    }
    const id = ++req.current;
    setPhase({ k: 'loading' });
    try {
      const data = await client.aiRecommendations(assetPayload);
      if (id !== req.current) return;
      if (data.routes.length === 0 && data.unavailable.length > 0) setPhase({ k: 'empty' });
      else setPhase({ k: 'routes', data });
    } catch (err) {
      if (id !== req.current) return;
      setPhase(errPhase(err));
    }
  }

  async function ask(q: string) {
    const trimmed = q.trim().slice(0, 1000);
    if (!trimmed || phase.k === 'loading') return;
    const id = ++req.current;
    setPhase({ k: 'loading' });
    try {
      const data = await client.aiAssistant(trimmed);
      if (id !== req.current) return;
      setPhase({ k: 'help', data });
    } catch (err) {
      if (id !== req.current) return;
      setPhase(errPhase(err));
    }
  }

  useEffect(() => {
    if (!open) return;
    if (tab === 'routes') void loadRoutes();
    else setPhase({ k: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, sessionId]);

  if (!mounted || assetPayload.length === 0) return null;

  const thinking = phase.k === 'loading';
  const amount = amountLabel.replace(/^\$/, '').replace(/\.00$/, '');

  return createPortal(
    <div ref={rootRef} className="demo-tendrai-fab-root" data-open={open ? 'true' : 'false'}>
      {open ? (
        <section id={panelId} className="demo-tendrai demo-tendrai-panel" aria-label="Tendr AI">
          <div className="demo-tendrai-intro">
            <TendrAiGhost thinking={thinking} size={44} />
            <div className="demo-tendrai-intro-copy">
              <span className="demo-tendrai-kicker">Tendr AI</span>
              <p>
                {thinking
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

          {phase.k === 'rate' ? (
            <p className="demo-checkout-muted">Too many requests. Try again in a moment.</p>
          ) : null}
          {phase.k === 'unavailable' ? (
            <p className="demo-checkout-muted">{phase.message}</p>
          ) : null}
          {phase.k === 'empty' ? (
            <p className="demo-checkout-muted">No route previews for these tokens right now.</p>
          ) : null}

          {tab === 'routes' && phase.k === 'routes' ? (
            <div className="demo-tendrai-cards" role="list">
              {phase.data.source === 'simulated_quotes' ? (
                <p className="demo-checkout-muted">Test mode · simulated quotes</p>
              ) : null}
              <p className="demo-checkout-muted">
                Ranked by quoted input USD (excludes wallet gas). Previews expire quickly — get a
                fresh quote before paying.
              </p>
              {phase.data.routes.map((route) => {
                const labels = [
                  phase.data.recommended === route.asset_id ? 'Recommended' : null,
                  phase.data.cheapest === route.asset_id ? 'Cheapest' : null,
                  phase.data.fastest === route.asset_id ? 'Fastest' : null,
                ].filter(Boolean);
                const visuals = routeVisuals(options, route.asset_id, route.chain);
                return (
                  <button
                    key={route.asset_id}
                    type="button"
                    className="demo-tendrai-card"
                    role="listitem"
                    onClick={() => {
                      onPickRoute(route.asset_id);
                      setOpen(false);
                    }}
                  >
                    <span className="demo-tendrai-card-top">
                      <span className="demo-tendrai-card-kind">
                        {labels.join(' · ') || route.symbol}
                      </span>
                      <span className="demo-tendrai-card-eta">
                        {route.estimated_seconds != null
                          ? `~${Math.max(1, Math.round(route.estimated_seconds / 60))}m`
                          : 'ETA —'}
                      </span>
                    </span>
                    <span className="demo-tendrai-card-asset">
                      {visuals.iconSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={visuals.iconSrc} alt="" width={22} height={22} />
                      ) : null}
                      <span>{route.symbol}</span>
                      {visuals.chainLogoSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={visuals.chainLogoSrc}
                          alt=""
                          className="demo-tendrai-card-chain"
                          width={16}
                          height={16}
                        />
                      ) : null}
                      <span className="demo-tendrai-card-chain-name">{visuals.chainName}</span>
                    </span>
                    <span className="demo-tendrai-card-meta">
                      ~${route.amount_in_usd}
                      {route.balance_sufficient === false ? ' · low balance' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {tab === 'help' ? (
            <div className="checkout-ai-help">
              {phase.k === 'help' ? (
                <div className="checkout-ai-answer">
                  <p>{phase.data.answer}</p>
                  {phase.data.facts.length > 0 ? (
                    <ul>
                      {phase.data.facts.map((f) => (
                        <li key={f.id}>{f.text}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              <div className="checkout-ai-suggestions">
                {TENDR_AI_SUGGESTIONS.map((s) => (
                  <button key={s} type="button" disabled={thinking} onClick={() => void ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
              <form
                className="checkout-ai-ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(question);
                }}
              >
                <input
                  value={question}
                  maxLength={1000}
                  disabled={thinking}
                  placeholder="Ask about this payment"
                  aria-label="Ask Tendr AI"
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" disabled={thinking || !question.trim()}>
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
        onClick={() => setOpen((v) => !v)}
      >
        <TendrAiGhost thinking={false} size={28} />
        <span>AI</span>
      </button>
    </div>,
    document.body,
  );
}
