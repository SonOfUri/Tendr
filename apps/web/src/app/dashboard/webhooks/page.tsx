'use client';

import { useState } from 'react';
import { WebhookEventTypeValues } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { Webhook } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { Status, useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import type { WebhookDelivery, WebhookEndpoint } from '@/lib/payments';
import { withStepUp } from '@/lib/webauthn';

export default function WebhooksPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const key = context && canManage ? `${context.merchantId}:${context.livemode}` : null;
  const endpoints = useLoad(
    () => api<{ endpoints: WebhookEndpoint[] }>('/v1/webhooks/endpoints'),
    key,
  );
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  if (!store || !context) return null;

  return (
    <div className="stack">
      <PageHeader
        title="Webhooks"
        description={
          <>
            Signed events sent to your server in {context.livemode ? 'live' : 'test'} mode. Each
            request carries a <code>Tendr-Signature</code> header; failed sends are retried for 3
            days, and you can resend any delivery.
          </>
        }
      />
      {!canManage ? (
        <Alert tone="info">Only owners and admins manage webhook endpoints.</Alert>
      ) : (
        <>
          <Panel title="Add an endpoint">
            <div id="add-webhook">
              <CreateForm
                livemode={context.livemode}
                onCreated={(url, s) => {
                  setSecret({ url, secret: s });
                  void endpoints.reload();
                }}
              />
            </div>
          </Panel>
          {secret && (
            <Alert tone="warning">
              Signing secret for {secret.url} — copy it now, it is not shown again:{' '}
              <code className="dash-mono" data-testid="webhook-secret">
                {secret.secret}
              </code>
            </Alert>
          )}
          {!endpoints.data ? (
            !endpoints.error && <PageSkeleton label="Loading endpoints" />
          ) : endpoints.data.endpoints.length === 0 ? (
            <EmptyState
              icon={<Webhook size={22} strokeWidth={1.75} />}
              title="No endpoints yet"
              description="Add a URL to receive signed webhook events from Tendr."
              action={
                <a href="#add-webhook" className="dash-empty-cta">
                  Add one
                </a>
              }
            />
          ) : (
            endpoints.data.endpoints.map((e) => (
              <EndpointCard
                key={e.id}
                endpoint={e}
                onSecret={(s) => setSecret({ url: e.url, secret: s })}
                onChanged={() => void endpoints.reload()}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function CreateForm({
  livemode,
  onCreated,
}: {
  livemode: boolean;
  onCreated: (url: string, secret: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const { busy, run } = useAction();

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

  return (
    <form onSubmit={submit} className="form">
      <label className="field">
        <span>URL</span>
        <input
          type="url"
          name="webhook-url"
          required
          placeholder={livemode ? 'https://shop.example/tendr' : 'https://… or http://localhost'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <fieldset className="field">
        <legend className="dash-small">Events (none selected: all)</legend>
        {WebhookEventTypeValues.map((t) => (
          <label key={t} className="dash-small inline-field">
            <input
              type="checkbox"
              checked={events.includes(t)}
              onChange={(e) =>
                setEvents((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))
              }
            />{' '}
            {t}
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={busy || !url}>
        {busy ? 'Adding…' : 'Add endpoint'}
      </Button>
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

  return (
    <Panel title={<span className="dash-mono">{endpoint.url}</span>}>
      <p className="dash-muted dash-small">
        {endpoint.events.length === 0 ? 'All events' : endpoint.events.join(', ')} · added{' '}
        {new Date(endpoint.created_at).toLocaleDateString()}
      </p>
      <div className="row">
        <Button variant="secondary" onClick={() => void test()} disabled={action.busy}>
          Send a test event
        </Button>
        <Button variant="secondary" onClick={() => void rotate()} disabled={action.busy}>
          Rotate secret
        </Button>
        <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide deliveries' : 'Delivery log'}
        </Button>
        <button type="button" className="link-button dash-small" onClick={() => void remove()}>
          Delete
        </button>
      </div>
      {open &&
        (!deliveries.data ? (
          <PageSkeleton label="Loading deliveries" rows={2} />
        ) : deliveries.data.deliveries.length === 0 ? (
          <p className="dash-muted">No deliveries yet.</p>
        ) : (
          <ul className="list">
            {deliveries.data.deliveries.map((d) => (
              <li key={d.id}>
                <span className="grow">
                  {d.event_type}{' '}
                  <span className="dash-muted dash-small dash-mono">{d.event_id}</span>
                  <br />
                  <span className="dash-muted dash-small">
                    {new Date(d.created_at).toLocaleString()} · {d.attempts} attempt
                    {d.attempts === 1 ? '' : 's'}
                    {d.status_code !== null ? ` · HTTP ${d.status_code}` : ''}
                    {d.last_error ? ` · ${d.last_error}` : ''}
                    {d.next_retry_at
                      ? ` · next try ${new Date(d.next_retry_at).toLocaleString()}`
                      : ''}
                  </span>
                </span>
                <Status status={d.status} />
                <Button
                  variant="secondary"
                  onClick={() => void resend(d.id)}
                  disabled={action.busy}
                >
                  Resend
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </Panel>
  );
}
