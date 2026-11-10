'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CheckoutMetrics, MerchantInsights } from '@tendr/contracts';
import { Button } from '@tendr/ui';
import { ArrowRight, LineChart, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { EmptyState, ErrorState } from '@/components/dashboard/ui';

type Phase =
  | { k: 'loading' }
  | { k: 'ready'; data: MerchantInsights }
  | { k: 'empty'; days: number }
  | { k: 'unavailable'; message: string }
  | { k: 'rate' };

type Explain =
  | { k: 'idle' }
  | { k: 'loading' }
  | { k: 'done'; answer: string; facts: { id: string; text: string }[] }
  | { k: 'unavailable'; message: string }
  | { k: 'rate' };

type FunnelStep = {
  key: string;
  label: string;
  value: number;
  /** Share of previous step retained; null for the first step. */
  retainPct: number | null;
};

function funnelSteps(m: CheckoutMetrics): FunnelStep[] {
  const values = [
    m.sessions_created,
    m.sessions_quoted,
    m.sessions_with_deposit,
    m.sessions_settled,
  ];
  const labels = ['Created', 'Quoted', 'Deposited', 'Settled'];
  const keys = ['created', 'quoted', 'deposited', 'settled'];
  return values.map((value, i) => {
    const prev = i === 0 ? null : values[i - 1];
    const retainPct =
      prev == null || prev === 0 ? (i === 0 ? null : 0) : Math.round((value / prev) * 1000) / 10;
    return { key: keys[i]!, label: labels[i]!, value, retainPct };
  });
}

function formatDelta(pp: string | null): { text: string; tone: 'up' | 'down' | 'flat' } | null {
  if (pp == null || pp === '') return null;
  const n = Number(pp);
  if (!Number.isFinite(n)) return { text: `${pp} pp vs prior`, tone: 'flat' };
  if (n > 0) return { text: `+${pp} pp vs prior`, tone: 'up' };
  if (n < 0) return { text: `${pp} pp vs prior`, tone: 'down' };
  return { text: '0 pp vs prior', tone: 'flat' };
}

export function AiInsightsPanel({
  merchantId,
  livemode,
}: {
  merchantId: string;
  livemode: boolean;
}) {
  const [days] = useState(30);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [explain, setExplain] = useState<Explain>({ k: 'idle' });
  const req = useRef(0);

  function load() {
    const id = ++req.current;
    setPhase({ k: 'loading' });
    setExplain({ k: 'idle' });
    void api<MerchantInsights>(`/v1/ai/insights?days=${days}`)
      .then((data) => {
        if (id !== req.current) return;
        const c = data.current;
        const empty =
          c.sessions_created === 0 &&
          c.sessions_quoted === 0 &&
          c.sessions_settled === 0 &&
          c.sessions_with_deposit === 0;
        setPhase(empty ? { k: 'empty', days: data.window.days } : { k: 'ready', data });
      })
      .catch((err) => {
        if (id !== req.current) return;
        if (err instanceof ApiError && (err.status === 429 || err.code === 'RATE_LIMITED')) {
          setPhase({ k: 'rate' });
        } else if (
          err instanceof ApiError &&
          (err.status === 503 ||
            err.code === 'PROVIDER_NOT_CONFIGURED' ||
            err.code === 'PROVIDER_UNAVAILABLE')
        ) {
          setPhase({ k: 'unavailable', message: 'Insights are unavailable right now.' });
        } else {
          setPhase({
            k: 'unavailable',
            message: err instanceof Error ? err.message : 'Could not load insights.',
          });
        }
      });
  }

  useEffect(() => {
    load();
    // Reload when store/mode changes; days is fixed for now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId, livemode, days]);

  async function onExplain() {
    if (explain.k === 'loading') return;
    const id = ++req.current;
    setExplain({ k: 'loading' });
    try {
      const res = await api<{
        answer: string;
        facts: { id: string; text: string }[];
        report: MerchantInsights;
      }>('/v1/ai/insights', {
        method: 'POST',
        json: { days, question: 'Summarize checkout conversion and drop-offs.' },
      });
      if (id !== req.current) return;
      setPhase({ k: 'ready', data: res.report });
      setExplain({ k: 'done', answer: res.answer, facts: res.facts });
    } catch (err) {
      if (id !== req.current) return;
      if (err instanceof ApiError && (err.status === 429 || err.code === 'RATE_LIMITED')) {
        setExplain({ k: 'rate' });
      } else {
        setExplain({
          k: 'unavailable',
          message: err instanceof Error ? err.message : 'Explanation unavailable.',
        });
      }
    }
  }

  const ready = phase.k === 'ready' ? phase.data : null;
  const steps = useMemo(() => (ready ? funnelSteps(ready.current) : []), [ready]);
  const delta = ready ? formatDelta(ready.conversion_change_percentage_points) : null;
  const conversion =
    ready?.current.conversion_percent == null || ready.current.conversion_percent === ''
      ? null
      : `${ready.current.conversion_percent}%`;

  if (phase.k === 'loading') {
    return (
      <div className="ins" aria-busy="true" aria-label="Loading insights">
        <div className="ins-skeleton ins-skeleton--hero" />
        <div className="ins-skeleton ins-skeleton--funnel" />
        <div className="ins-skeleton ins-skeleton--row" />
      </div>
    );
  }

  if (phase.k === 'rate') {
    return (
      <ErrorState message="Too many requests. Try again later." onRetry={() => load()} />
    );
  }

  if (phase.k === 'unavailable') {
    return <ErrorState message={phase.message} onRetry={() => load()} />;
  }

  if (phase.k === 'empty') {
    return (
      <EmptyState
        icon={<LineChart size={22} strokeWidth={1.75} aria-hidden />}
        title="No checkout sessions yet"
        description={`Nothing to measure in the last ${phase.days} days. Insights appear once shoppers start checkout sessions in this mode.`}
      />
    );
  }

  if (!ready) return null;

  return (
    <div className="ins">
      <section className="ins-hero" aria-label="Conversion">
        <div className="ins-hero-main">
          <p className="ins-kicker">
            Last {ready.window.days} days
            {!livemode ? <span className="ins-badge">Test</span> : null}
          </p>
          <p className="ins-hero-value">{conversion ?? '—'}</p>
          <p className="ins-hero-label">Checkout conversion</p>
          {delta ? (
            <p className={`ins-delta ins-delta--${delta.tone}`}>{delta.text}</p>
          ) : (
            <p className="ins-delta ins-delta--flat">No prior-window comparison</p>
          )}
        </div>
        <p className="ins-hero-meta">
          Sessions, not visitors · Generated {new Date(ready.generated_at).toLocaleString()}
        </p>
      </section>

      <section className="ins-funnel" aria-label="Checkout funnel">
        <div className="ins-section-head">
          <h2 className="ins-section-title">Funnel</h2>
          <p className="ins-section-desc">How sessions move from create to settle</p>
        </div>
        <ol className="ins-funnel-steps">
          {steps.map((step, i) => (
            <li key={step.key} className="ins-funnel-step">
              {i > 0 ? (
                <span className="ins-funnel-join" aria-hidden>
                  <ArrowRight size={16} strokeWidth={2} />
                  {step.retainPct != null ? (
                    <span className="ins-funnel-retain">{step.retainPct}%</span>
                  ) : null}
                </span>
              ) : null}
              <div className="ins-funnel-card">
                <span className="ins-funnel-label">{step.label}</span>
                <strong className="ins-funnel-value">{step.value.toLocaleString()}</strong>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="ins-secondary" aria-label="Other metrics">
        <div className="ins-secondary-item">
          <span>Expired without deposit</span>
          <strong>{ready.current.expired_without_deposit.toLocaleString()}</strong>
        </div>
        <div className="ins-secondary-item">
          <span>With refunds</span>
          <strong>{ready.current.sessions_with_refunds.toLocaleString()}</strong>
        </div>
        <div className="ins-secondary-item ins-secondary-item--wide">
          <span>Settled order totals</span>
          <strong>
            {ready.current.settled_order_totals.length
              ? ready.current.settled_order_totals
                  .map((t) => `${t.amount} ${t.currency}`)
                  .join(' · ')
              : '—'}
          </strong>
        </div>
      </section>

      <section className="ins-explain" aria-label="Tendr AI explanation">
        <div className="ins-explain-head">
          <div className="ins-explain-copy">
            <p className="ins-explain-title">
              <Sparkles size={16} strokeWidth={2} aria-hidden />
              Tendr AI
            </p>
            <p className="ins-explain-desc">
              Summarize conversion and drop-offs from this report. AI never moves money or changes
              checkout.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={explain.k === 'loading'}
            onClick={() => void onExplain()}
          >
            {explain.k === 'loading' ? 'Explaining…' : 'Explain these results'}
          </Button>
        </div>

        {explain.k === 'done' ? (
          <div className="ins-explain-body">
            <p>{explain.answer}</p>
            {explain.facts.length > 0 ? (
              <ul>
                {explain.facts.map((f) => (
                  <li key={f.id}>{f.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {explain.k === 'rate' ? (
          <p className="ins-explain-status">Rate limited — try explaining later.</p>
        ) : null}
        {explain.k === 'unavailable' ? (
          <p className="ins-explain-status">{explain.message}</p>
        ) : null}
      </section>
    </div>
  );
}
