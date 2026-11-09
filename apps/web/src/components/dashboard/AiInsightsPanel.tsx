'use client';

import { useEffect, useRef, useState } from 'react';
import type { MerchantInsights } from '@tendr/contracts';
import { Button } from '@tendr/ui';
import { api, ApiError } from '@/lib/api';
import { Panel } from '@/components/dashboard/ui';

type Phase =
  | { k: 'loading' }
  | { k: 'ready'; data: MerchantInsights }
  | { k: 'empty' }
  | { k: 'unavailable'; message: string }
  | { k: 'rate' };

type Explain =
  | { k: 'idle' }
  | { k: 'loading' }
  | { k: 'done'; answer: string; facts: { id: string; text: string }[] }
  | { k: 'unavailable'; message: string }
  | { k: 'rate' };

function metric(label: string, value: number | string | null) {
  return (
    <div className="ai-insight-metric">
      <span>{label}</span>
      <strong>{value == null || value === '' ? 'No data' : value}</strong>
    </div>
  );
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

  useEffect(() => {
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
        setPhase(empty ? { k: 'empty' } : { k: 'ready', data });
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

  return (
    <Panel
      title="Checkout insights"
      action={
        phase.k === 'ready' || phase.k === 'empty' ? (
          <Button
            variant="secondary"
            disabled={explain.k === 'loading'}
            onClick={() => void onExplain()}
          >
            {explain.k === 'loading' ? 'Explaining…' : 'Explain these results'}
          </Button>
        ) : null
      }
    >
      {phase.k === 'loading' ? <p className="dash-muted">Loading insights…</p> : null}
      {phase.k === 'rate' ? <p className="dash-muted">Too many requests. Try again later.</p> : null}
      {phase.k === 'unavailable' ? <p className="dash-muted">{phase.message}</p> : null}
      {phase.k === 'empty' ? (
        <p className="dash-muted">No checkout sessions in the last {days} days yet.</p>
      ) : null}
      {phase.k === 'ready' ? (
        <>
          <p className="dash-muted dash-small">
            Last {phase.data.window.days} days · sessions, not visitors · generated{' '}
            {new Date(phase.data.generated_at).toLocaleString()}
            {livemode ? '' : ' · Test'}
          </p>
          <div className="ai-insight-grid">
            {metric('Created', phase.data.current.sessions_created)}
            {metric('Quoted', phase.data.current.sessions_quoted)}
            {metric('Deposited', phase.data.current.sessions_with_deposit)}
            {metric('Settled', phase.data.current.sessions_settled)}
            {metric('Expired w/o deposit', phase.data.current.expired_without_deposit)}
            {metric('With refunds', phase.data.current.sessions_with_refunds)}
            {metric(
              'Conversion',
              phase.data.current.conversion_percent == null
                ? null
                : `${phase.data.current.conversion_percent}%`,
            )}
            {metric(
              'vs prior window',
              phase.data.conversion_change_percentage_points == null
                ? null
                : `${phase.data.conversion_change_percentage_points} pp`,
            )}
          </div>
          {phase.data.current.settled_order_totals.length > 0 ? (
            <p className="dash-muted dash-small">
              Settled order totals:{' '}
              {phase.data.current.settled_order_totals
                .map((t) => `${t.amount} ${t.currency}`)
                .join(' · ')}
            </p>
          ) : null}
        </>
      ) : null}
      {explain.k === 'done' ? (
        <div className="ai-insight-explain">
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
      {explain.k === 'rate' ? <p className="dash-muted">Rate limited — try explaining later.</p> : null}
      {explain.k === 'unavailable' ? <p className="dash-muted">{explain.message}</p> : null}
    </Panel>
  );
}
