'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Ban, Check, Copy, ExternalLink, Key, Plus, RefreshCw, X } from 'lucide-react';
import { ScopeValues, type Scope } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api, type StoreContext } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

interface ApiKey {
  id: string;
  name: string;
  kind: 'secret' | 'publishable';
  livemode: boolean;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const DEFAULT_SCOPES: Scope[] = ['sessions:read', 'sessions:write', 'payments:read', 'events:read'];

const LABELS: Record<Scope, string> = {
  'sessions:read': 'Read checkout sessions',
  'sessions:write': 'Create and cancel checkout sessions',
  'payments:read': 'Read payments',
  'refunds:write': 'Request refunds',
  'payment_links:read': 'Read payment links',
  'payment_links:write': 'Manage payment links',
  'webhooks:read': 'Read webhooks',
  'webhooks:write': 'Manage webhooks',
  'events:read': 'Read events',
  'themes:read': 'Read checkout themes',
  'themes:write': 'Manage checkout themes',
};

const SCOPE_GROUPS: { id: string; label: string; scopes: Scope[] }[] = [
  {
    id: 'sessions',
    label: 'Checkout sessions',
    scopes: ScopeValues.filter((s) => s.startsWith('sessions:')),
  },
  {
    id: 'payments',
    label: 'Payments & refunds',
    scopes: ScopeValues.filter((s) => s.startsWith('payments:') || s.startsWith('refunds:')),
  },
  {
    id: 'links',
    label: 'Payment links',
    scopes: ScopeValues.filter((s) => s.startsWith('payment_links:')),
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    scopes: ScopeValues.filter((s) => s.startsWith('webhooks:')),
  },
  {
    id: 'events',
    label: 'Events',
    scopes: ScopeValues.filter((s) => s.startsWith('events:')),
  },
  {
    id: 'themes',
    label: 'Themes',
    scopes: ScopeValues.filter((s) => s.startsWith('themes:')),
  },
];

export default function ApiKeysPage() {
  const { store, context } = useDashboard();
  if (!store || !context) return null;
  if (store.role !== 'owner' && store.role !== 'admin') {
    return (
      <div className="stack">
        <PageHeader title="API keys" />
        <Alert tone="info">Only owners and admins can manage API keys.</Alert>
      </div>
    );
  }
  // Unmount on every store/mode change so a one-time secret can never follow the selection.
  return <KeyManager key={`${context.merchantId}:${context.livemode}`} context={context} />;
}

function KeyManager({ context }: { context: StoreContext }) {
  const keys = useLoad(
    () => api<{ api_keys: ApiKey[] }>('/v1/api_keys', { store: context }),
    context.merchantId,
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [issued, setIssued] = useState<{ api_key: ApiKey; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const action = useAction();
  const mode = context.livemode ? 'live' : 'test';
  const list = keys.data?.api_keys ?? [];
  const active = list.filter((k) => !k.revoked_at);
  const revoked = list.filter((k) => k.revoked_at);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (action.busy || issued) return;
    const result = await action.run(() =>
      withStepUp(() =>
        api<{ api_key: ApiKey; secret: string }>('/v1/api_keys', {
          method: 'POST',
          store: context,
          json: { name: name.trim(), scopes },
        }),
      ),
    );
    if (result) {
      setIssued(result);
      setCreating(false);
      setName('');
      setScopes(DEFAULT_SCOPES);
      setCopied(false);
      setCopyError(false);
    }
    // A lost creation response can still have created the key: show its metadata for revocation.
    await keys.reload();
  }

  async function revoke(id: string) {
    const result = await action.run(() =>
      withStepUp(() =>
        api<{ api_key: ApiKey }>(`/v1/api_keys/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          store: context,
        }),
      ),
    );
    if (result) {
      if (issued?.api_key.id === id) setIssued(null);
      setRevoking(null);
      await keys.reload();
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  function toggleScope(scope: Scope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  function selectGroup(groupScopes: Scope[]) {
    setScopes((current) => {
      const missing = groupScopes.filter((s) => !current.includes(s));
      if (missing.length === 0) return current.filter((s) => !groupScopes.includes(s));
      return [...new Set([...current, ...missing])];
    });
  }

  return (
    <div className="stack">
      <PageHeader
        title="API keys"
        description={
          <>
            Secret keys for this store in {mode} mode. Use them on your server with the Tendr API or
            SDK. Connected-site keys live under{' '}
            <Link href="/dashboard/settings/connected-sites" className="dash-text-link dash-btn-icon">
              <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
              Connected sites
            </Link>
            .
          </>
        }
        actions={
          <div className="dash-action-bar" role="group" aria-label="API key actions">
            <button
              type="button"
              className="dash-action-chip"
              data-tone="secondary"
              disabled={action.busy}
              onClick={() => void keys.reload()}
            >
              <span className="dash-action-chip-icon" aria-hidden>
                <RefreshCw size={15} strokeWidth={1.85} />
              </span>
              <span className="dash-action-chip-label">Refresh</span>
            </button>
            <button
              type="button"
              className="dash-action-chip"
              data-tone="primary"
              data-active={creating || undefined}
              disabled={!!issued}
              onClick={() => setCreating((v) => !v)}
            >
              <span className="dash-action-chip-icon" aria-hidden>
                {creating ? <X size={15} strokeWidth={1.85} /> : <Plus size={15} strokeWidth={1.85} />}
              </span>
              <span className="dash-action-chip-label">
                {creating ? 'Cancel' : `Create ${mode} key`}
              </span>
            </button>
          </div>
        }
      />

      {issued ? (
        <Panel title={`Save your new ${mode} key`}>
          <Alert tone="warning">
            This secret is shown once. Copy it into your server environment variables — keep it out
            of browser code and public repos.
          </Alert>
          <label className="field">
            <span>Secret API key</span>
            <input
              readOnly
              value={issued.secret}
              className="dash-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="dash-muted dash-small">
            {issued.api_key.name} · <span className="dash-mono">{issued.api_key.prefix}…</span>
          </p>
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
                  Copy key
                </>
              )}
            </Button>
            <Button variant="secondary" className="dash-btn-icon" onClick={() => setIssued(null)}>
              <Check size={16} strokeWidth={1.75} aria-hidden />
              I’ve saved this key
            </Button>
          </div>
          {copyError ? (
            <Alert tone="info">
              Clipboard access failed. Select the key above and copy it manually.
            </Alert>
          ) : null}
        </Panel>
      ) : null}

      {creating && !issued ? (
        <Panel title={`New ${mode} secret key`}>
          <form className="ak-create" onSubmit={create}>
            <label className="field">
              <span>Key name</span>
              <input
                name="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                placeholder="My store backend"
              />
            </label>

            <div className="ak-scopes">
              <div className="ak-scopes-head">
                <div>
                  <strong>Permissions</strong>
                  <p className="dash-muted dash-small">
                    {scopes.length} selected. Wallet transfers and refund execution still need
                    signer approval.
                  </p>
                </div>
                <button
                  type="button"
                  className="link-button dash-small"
                  onClick={() => setScopes([...DEFAULT_SCOPES])}
                >
                  Reset defaults
                </button>
              </div>

              <div className="ak-scope-groups">
                {SCOPE_GROUPS.map((group) => {
                  if (group.scopes.length === 0) return null;
                  const selectedCount = group.scopes.filter((s) => scopes.includes(s)).length;
                  return (
                    <section key={group.id} className="ak-scope-group">
                      <div className="ak-scope-group-head">
                        <span>{group.label}</span>
                        <button
                          type="button"
                          className="link-button dash-small"
                          onClick={() => selectGroup(group.scopes)}
                        >
                          {selectedCount === group.scopes.length ? 'Clear' : 'All'}
                        </button>
                      </div>
                      <div className="ak-scope-chips">
                        {group.scopes.map((scope) => {
                          const on = scopes.includes(scope);
                          return (
                            <button
                              key={scope}
                              type="button"
                              className="ak-scope-chip"
                              data-on={on || undefined}
                              aria-pressed={on}
                              title={LABELS[scope]}
                              onClick={() => toggleScope(scope)}
                            >
                              <span className="ak-scope-chip-code">{scope}</span>
                              <span className="ak-scope-chip-label">{LABELS[scope]}</span>
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
              <Button
                type="submit"
                className="dash-btn-icon"
                disabled={action.busy || !name.trim() || scopes.length === 0}
              >
                {action.busy && !revoking ? (
                  'Creating…'
                ) : (
                  <>
                    <Key size={16} strokeWidth={1.75} aria-hidden />
                    {`Create ${mode} key`}
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="dash-btn-icon"
                onClick={() => setCreating(false)}
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}

      {keys.error ? (
        <ErrorState message={keys.error} onRetry={() => void keys.reload()} />
      ) : !keys.data ? (
        <PageSkeleton label="Loading API keys" />
      ) : list.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Key size={22} strokeWidth={1.75} />}
            title={`No ${mode} keys yet`}
            description="Create a secret key for your server to call the Tendr API."
            action={
              <button
                type="button"
                className="dash-empty-cta dash-btn-icon"
                disabled={!!issued}
                onClick={() => setCreating(true)}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                Create key
              </button>
            }
          />
        </Panel>
      ) : (
        <>
          <div className="ak-grid">
            {active.map((key) => (
              <KeyCard
                key={key.id}
                apiKey={key}
                revoking={revoking === key.id}
                busy={action.busy}
                onRevokeAsk={() => setRevoking(key.id)}
                onRevokeCancel={() => setRevoking(null)}
                onRevokeConfirm={() => void revoke(key.id)}
              />
            ))}
          </div>
          {revoked.length > 0 ? (
            <Panel title="Revoked">
              <div className="ak-grid">
                {revoked.map((key) => (
                  <KeyCard key={key.id} apiKey={key} revoked />
                ))}
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

function KeyCard({
  apiKey,
  revoked,
  revoking,
  busy,
  onRevokeAsk,
  onRevokeCancel,
  onRevokeConfirm,
}: {
  apiKey: ApiKey;
  revoked?: boolean;
  revoking?: boolean;
  busy?: boolean;
  onRevokeAsk?: () => void;
  onRevokeCancel?: () => void;
  onRevokeConfirm?: () => void;
}) {
  return (
    <article className="ak-card" data-revoked={revoked || undefined}>
      <header className="ak-card-head">
        <div className="ak-card-icon" aria-hidden>
          <Key size={18} strokeWidth={1.75} />
        </div>
        <div className="ak-card-title">
          <strong>{apiKey.name}</strong>
          <span className="ak-card-prefix dash-mono">{apiKey.prefix}…</span>
          <p className="dash-muted dash-small">
            {apiKey.kind} · created {new Date(apiKey.created_at).toLocaleDateString()}
            {apiKey.last_used_at
              ? ` · last used ${new Date(apiKey.last_used_at).toLocaleString()}`
              : ' · never used'}
          </p>
        </div>
        <span className="dash-pill" data-tone={revoked ? 'warn' : 'ok'}>
          {revoked ? 'Revoked' : 'Active'}
        </span>
      </header>

      <div className="ak-card-scopes">
        {apiKey.scopes.length === 0 ? (
          <span className="dash-muted dash-small">No permissions</span>
        ) : (
          apiKey.scopes.map((scope) => (
            <span key={scope} className="ak-scope-chip" data-static title={LABELS[scope as Scope]}>
              <span className="ak-scope-chip-code">{scope}</span>
            </span>
          ))
        )}
      </div>

      {!revoked ? (
        revoking ? (
          <div className="ak-card-confirm">
            <Alert tone="warning">
              Revoke “{apiKey.name}”? Integrations using this key will lose API access immediately.
            </Alert>
            <div className="actions">
              <Button className="dash-btn-icon" disabled={busy} onClick={onRevokeConfirm}>
                {busy ? (
                  'Waiting for your passkey…'
                ) : (
                  <>
                    <Ban size={16} strokeWidth={1.75} aria-hidden />
                    Confirm revoke
                  </>
                )}
              </Button>
              <Button
                variant="secondary"
                className="dash-btn-icon"
                disabled={busy}
                onClick={onRevokeCancel}
              >
                <X size={16} strokeWidth={1.75} aria-hidden />
                Keep key
              </Button>
            </div>
          </div>
        ) : (
          <div className="ak-card-actions">
            <button
              type="button"
              className="dash-action-chip"
              data-tone="secondary"
              disabled={busy}
              onClick={onRevokeAsk}
            >
              <span className="dash-action-chip-icon" aria-hidden>
                <Ban size={15} strokeWidth={1.85} />
              </span>
              <span className="dash-action-chip-label">Revoke</span>
            </button>
          </div>
        )
      ) : null}
    </article>
  );
}
