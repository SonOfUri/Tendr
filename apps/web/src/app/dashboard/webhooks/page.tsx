'use client';

import { useMemo, useState } from 'react';
import { WebhookEventTypeValues } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  RotateCw,
  Send,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import type { WebhookDelivery, WebhookEndpoint } from '@/lib/payments';
import { withStepUp } from '@/lib/webauthn';

const EVENT_GROUPS: { id: string; label: string; events: readonly string[] }[] = [
  {
    id: 'checkout',
    label: 'Checkout',
    events: WebhookEventTypeValues.filter((e) => e.startsWith('checkout.')),
  },
  {
    id: 'payment',
    label: 'Payments',
    events: WebhookEventTypeValues.filter((e) => e.startsWith('payment.')),
  },
  {
    id: 'refund',
    label: 'Refunds',
    events: WebhookEventTypeValues.filter((e) => e.startsWith('refund.')),
  },
  {
    id: 'gas',
    label: 'Gas',
    events: WebhookEventTypeValues.filter((e) => e.startsWith('gas.')),
  },
  {
    id: 'hook',
    label: 'Delivery',
    events: WebhookEventTypeValues.filter((e) => e.startsWith('hook.')),
  },
];

function endpointHost(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: `${u.pathname}${u.search}` || '/' };
  } catch {
    return { host: url, path: '' };
  }
}

export default function WebhooksPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const key = context && canManage ? `${context.merchantId}:${context.livemode}` : null;
  const endpoints = useLoad(
    () => api<{ endpoints: WebhookEndpoint[] }>('/v1/webhooks/endpoints'),
    key,
  );
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  if (!store || !context) return null;

  const list = endpoints.data?.endpoints ?? [];

  return (
    <div className="stack">
      <PageHeader
        title="Webhooks"
        description={
          <>
            Signed events for {context.livemode ? 'live' : 'test'} mode. Each request includes a{' '}
            <code>Tendr-Signature</code> header. Failed deliveries retry for 3 days.
          </>
        }
        actions={
          canManage ? (
            <div className="dash-action-bar" role="group" aria-label="Webhook actions">
              <button
                type="button"
                className="dash-action-chip"
                data-tone="primary"
                data-active={adding || undefined}
                onClick={() => {
                  setAdding((v) => !v);
                }}
              >
                <span className="dash-action-chip-icon" aria-hidden>
                  {adding ? <X size={15} strokeWidth={1.85} /> : <Plus size={15} strokeWidth={1.85} />}
                </span>
                <span className="dash-action-chip-label">
                  {adding ? 'Cancel' : 'Add endpoint'}
                </span>
              </button>
            </div>
          ) : null
        }
      />

      {!canManage ? (
        <Alert tone="info">Only owners and admins manage webhook endpoints.</Alert>
      ) : (
        <>
          {adding ? (
            <Panel title="New endpoint">
              <div id="add-webhook">
                <CreateForm
                  livemode={context.livemode}
                  onCreated={(url, s) => {
                    setSecret({ url, secret: s });
                    setAdding(false);
                    void endpoints.reload();
                  }}
                  onCancel={() => setAdding(false)}
                />
              </div>
            </Panel>
          ) : null}

          {secret ? (
            <SecretBanner
              url={secret.url}
              value={secret.secret}
              onDismiss={() => setSecret(null)}
            />
          ) : null}

          {endpoints.error ? (
            <ErrorState message={endpoints.error} onRetry={() => void endpoints.reload()} />
          ) : !endpoints.data ? (
            <PageSkeleton label="Loading endpoints" />
          ) : list.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<Webhook size={22} strokeWidth={1.75} />}
                title="No endpoints yet"
                description="Add a HTTPS URL to receive signed payment and refund events from Tendr."
                action={
                  <button
                    type="button"
                    className="dash-empty-cta dash-btn-icon"
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={16} strokeWidth={1.75} aria-hidden />
                    Add endpoint
                  </button>
                }
              />
            </Panel>
          ) : (
            <div className="wh-grid">
              {list.map((e) => (
                <EndpointCard
                  key={e.id}
                  endpoint={e}
                  onSecret={(s) => setSecret({ url: e.url, secret: s })}
                  onChanged={() => void endpoints.reload()}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SecretBanner({
  url,
  value,
  onDismiss,
}: {
  url: string;
  value: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <Panel title="Save this signing secret">
      <p className="dash-muted dash-small">
        Shown once for <span className="dash-mono">{url}</span>. Store it on your server to verify{' '}
        <code>Tendr-Signature</code>.
      </p>
      <label className="field">
        <span>Signing secret</span>
        <input
          readOnly
          value={value}
          className="dash-mono"
          data-testid="webhook-secret"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="actions">
        <Button className="dash-btn-icon" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check size={16} strokeWidth={1.75} aria-hidden />
              Copied
            </>
          ) : (
            <>
              <Copy size={16} strokeWidth={1.75} aria-hidden />
              Copy secret
            </>
          )}
        </Button>
        <Button variant="secondary" className="dash-btn-icon" onClick={onDismiss}>
          <Check size={16} strokeWidth={1.75} aria-hidden />
          I’ve saved it
        </Button>
      </div>
      {copyError ? (
        <Alert tone="info">Clipboard access failed. Select the secret above and copy it manually.</Alert>
      ) : null}
    </Panel>
  );
}

function CreateForm({
  livemode,
  onCreated,
  onCancel,
}: {
  livemode: boolean;
  onCreated: (url: string, secret: string) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const { busy, run } = useAction();
  const allSelected = events.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await run(() =>
      withStepUp(() =>
        api<{ endpoint: WebhookEndpoint; secret: string }>('/v1/webhooks/endpoints', {
          method: 'POST',
          json: { url, ...(events.length > 0 ? { events } : {}) },
        }),
      ),
    );
    if (res) {
      onCreated(res.endpoint.url, res.secret);
      setUrl('');
      setEvents([]);
    }
  }

  function toggle(event: string) {
    setEvents((cur) => (cur.includes(event) ? cur.filter((x) => x !== event) : [...cur, event]));
  }

  function selectGroup(groupEvents: readonly string[]) {
    setEvents((cur) => {
      const missing = groupEvents.filter((e) => !cur.includes(e));
      if (missing.length === 0) return cur.filter((e) => !groupEvents.includes(e));
      return [...new Set([...cur, ...groupEvents])];
    });
  }

  return (
    <form onSubmit={submit} className="wh-create">
      <label className="field">
        <span>Endpoint URL</span>
        <input
          type="url"
          name="webhook-url"
          required
          placeholder={livemode ? 'https://shop.example/tendr/webhooks' : 'https://… or http://localhost'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <div className="wh-events">
        <div className="wh-events-head">
          <div>
            <strong>Events</strong>
            <p className="dash-muted dash-small">
              {allSelected
                ? 'None selected — this endpoint receives every event.'
                : `${events.length} selected`}
            </p>
          </div>
          {!allSelected ? (
            <button
              type="button"
              className="link-button dash-small"
              onClick={() => setEvents([])}
            >
              Receive all
            </button>
          ) : null}
        </div>

        <div className="wh-event-groups">
          {EVENT_GROUPS.map((group) => {
            if (group.events.length === 0) return null;
            const selectedCount = group.events.filter((e) => events.includes(e)).length;
            return (
              <section key={group.id} className="wh-event-group">
                <div className="wh-event-group-head">
                  <span>{group.label}</span>
                  <button
                    type="button"
                    className="link-button dash-small"
                    onClick={() => selectGroup(group.events)}
                  >
                    {selectedCount === group.events.length ? 'Clear' : 'All'}
                  </button>
                </div>
                <div className="wh-event-chips">
                  {group.events.map((event) => {
                    const on = events.includes(event);
                    return (
                      <button
                        key={event}
                        type="button"
                        className="wh-event-chip"
                        data-on={on || undefined}
                        aria-pressed={on}
                        onClick={() => toggle(event)}
                      >
                        {event}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="actions">
        <Button type="submit" className="dash-btn-icon" disabled={busy || !url}>
          {busy ? (
            'Adding…'
          ) : (
            <>
              <Plus size={16} strokeWidth={1.75} aria-hidden />
              Add endpoint
            </>
          )}
        </Button>
        <Button type="button" variant="ghost" className="dash-btn-icon" onClick={onCancel}>
          <X size={16} strokeWidth={1.75} aria-hidden />
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EndpointCard({
  endpoint,
  onSecret,
  onChanged,
}: {
  endpoint: WebhookEndpoint;
  onSecret: (secret: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const deliveries = useLoad(
    () =>
      api<{ deliveries: WebhookDelivery[] }>(
        `/v1/webhooks/endpoints/${encodeURIComponent(endpoint.id)}/deliveries`,
      ),
    open ? endpoint.id : null,
  );
  const action = useAction();
  const path = `/v1/webhooks/endpoints/${encodeURIComponent(endpoint.id)}`;
  const { host, path: urlPath } = useMemo(() => endpointHost(endpoint.url), [endpoint.url]);

  async function rotate() {
    const res = await action.run(() =>
      withStepUp(() => api<{ secret: string }>(`${path}/rotate`, { method: 'POST', json: {} })),
    );
    if (res) onSecret(res.secret);
  }
  async function test() {
    await action.run(() => api(`${path}/test`, { method: 'POST', json: {} }));
    if (open) void deliveries.reload();
    else setOpen(true);
  }
  async function remove() {
    if (!window.confirm(`Stop sending events to ${endpoint.url}?`)) return;
    const ok = await action.run(() => api(path, { method: 'DELETE' }));
    if (ok !== undefined) onChanged();
  }
  async function resend(id: string) {
    await action.run(() =>
      api(`/v1/webhooks/deliveries/${encodeURIComponent(id)}/resend`, { method: 'POST', json: {} }),
    );
    void deliveries.reload();
  }

  const eventLabel =
    endpoint.events.length === 0
      ? 'All events'
      : endpoint.events.length <= 3
        ? endpoint.events.join(', ')
        : `${endpoint.events.length} events`;

  return (
    <article className="wh-card">
      <header className="wh-card-head">
        <div className="wh-card-icon" aria-hidden>
          <Webhook size={18} strokeWidth={1.75} />
        </div>
        <div className="wh-card-title">
          <strong className="wh-card-host">{host}</strong>
          {urlPath ? <span className="wh-card-path dash-mono">{urlPath}</span> : null}
          <p className="dash-muted dash-small">
            {eventLabel} · added {new Date(endpoint.created_at).toLocaleDateString()}
          </p>
        </div>
        <span className="dash-pill" data-tone={endpoint.active ? 'ok' : 'warn'}>
          {endpoint.active ? 'Active' : 'Inactive'}
        </span>
      </header>

      {endpoint.events.length > 0 ? (
        <div className="wh-card-events">
          {endpoint.events.map((event) => (
            <span key={event} className="wh-event-chip" data-static>
              {event}
            </span>
          ))}
        </div>
      ) : (
        <p className="dash-muted dash-small wh-card-all">Receives every event type</p>
      )}

      <div className="wh-card-actions">
        <button
          type="button"
          className="dash-action-chip"
          data-tone="secondary"
          disabled={action.busy}
          onClick={() => void test()}
        >
          <span className="dash-action-chip-icon" aria-hidden>
            <Send size={15} strokeWidth={1.85} />
          </span>
          <span className="dash-action-chip-label">Test</span>
        </button>
        <button
          type="button"
          className="dash-action-chip"
          data-tone="secondary"
          disabled={action.busy}
          onClick={() => void rotate()}
        >
          <span className="dash-action-chip-icon" aria-hidden>
            <RotateCw size={15} strokeWidth={1.85} />
          </span>
          <span className="dash-action-chip-label">Rotate secret</span>
        </button>
        <button
          type="button"
          className="dash-action-chip"
          data-tone="secondary"
          data-active={open || undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="dash-action-chip-icon" aria-hidden>
            {open ? <ChevronUp size={15} strokeWidth={1.85} /> : <ChevronDown size={15} strokeWidth={1.85} />}
          </span>
          <span className="dash-action-chip-label">{open ? 'Hide log' : 'Delivery log'}</span>
        </button>
        <button
          type="button"
          className="dash-action-chip"
          data-tone="secondary"
          disabled={action.busy}
          onClick={() => void remove()}
        >
          <span className="dash-action-chip-icon" aria-hidden>
            <Trash2 size={15} strokeWidth={1.85} />
          </span>
          <span className="dash-action-chip-label">Delete</span>
        </button>
      </div>

      {open ? (
        <div className="wh-log">
          {!deliveries.data ? (
            <PageSkeleton label="Loading deliveries" rows={2} />
          ) : deliveries.data.deliveries.length === 0 ? (
            <p className="dash-muted dash-small">No deliveries yet. Send a test event to start.</p>
          ) : (
            <div className="dash-table-wrap">
              <table className="dash-table wh-log-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>When</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="wh-log-event">{d.event_type}</div>
                        <div className="dash-muted dash-small dash-mono">{d.event_id}</div>
                        <div className="dash-muted dash-small">
                          {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                          {d.status_code !== null ? ` · HTTP ${d.status_code}` : ''}
                          {d.last_error ? ` · ${d.last_error}` : ''}
                          {d.next_retry_at
                            ? ` · next ${new Date(d.next_retry_at).toLocaleString()}`
                            : ''}
                        </div>
                      </td>
                      <td className="dash-muted dash-small">
                        {new Date(d.created_at).toLocaleString()}
                      </td>
                      <td>
                        <Status status={d.status} />
                      </td>
                      <td>
                        <Button
                          variant="secondary"
                          className="dash-btn-icon"
                          onClick={() => void resend(d.id)}
                          disabled={action.busy}
                        >
                          <RotateCw size={16} strokeWidth={1.75} aria-hidden />
                          Resend
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}
