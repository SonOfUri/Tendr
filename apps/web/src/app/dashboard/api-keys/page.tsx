'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ScopeValues, type Scope } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
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

export default function ApiKeysPage() {
  const { store, context } = useDashboard();
  if (!store || !context) return null;
  if (store.role !== 'owner' && store.role !== 'admin')
    return (
      <div className="stack">
        <h1>API keys</h1>
        <Alert tone="info">Only owners and admins can manage API keys.</Alert>
      </div>
    );
  // Unmount on every store/mode change so a one-time secret can never follow the selection.
  return <KeyManager key={`${context.merchantId}:${context.livemode}`} context={context} />;
}

function KeyManager({ context }: { context: StoreContext }) {
  const keys = useLoad(
    () => api<{ api_keys: ApiKey[] }>('/v1/api_keys', { store: context }),
    context.merchantId,
  );
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [issued, setIssued] = useState<{ api_key: ApiKey; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const action = useAction();
  const mode = context.livemode ? 'live' : 'test';

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
      setName('');
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

  return (
    <div className="stack">
      <div>
        <h1>API keys</h1>
        <p className="muted">
          Keys for this store in {mode} mode. Use a secret key on your server to call the Tendr API
          or SDK.
        </p>
        <p className="muted small">
          Connected-site keys are managed under{' '}
          <Link href="/dashboard/settings/connected-sites">Connected sites</Link>.
        </p>
      </div>
      {issued && (
        <section className="card stack" aria-label="New API key">
          <h2>Save your new {mode} key</h2>
          <p>
            This key is shown once. Copy it into your server’s environment variables. Keep it out of
            browser code and public repositories.
          </p>
          <label className="field">
            <span>Secret API key</span>
            <input readOnly value={issued.secret} autoComplete="off" spellCheck={false} />
          </label>
          <div className="row">
            <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy key'}</Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              I’ve saved this key
            </Button>
          </div>
          {copyError && (
            <Alert tone="info">
              Clipboard access failed. Select the key above and copy it manually.
            </Alert>
          )}
        </section>
      )}
      <section className="card stack">
        <h2>Create a {mode} secret key</h2>
        <form className="form" onSubmit={create}>
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
          <fieldset className="field">
            <legend>Permissions</legend>
            {ScopeValues.map((scope) => (
              <label className="small inline-field" key={scope}>
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((current) =>
                      e.target.checked ? [...current, scope] : current.filter((s) => s !== scope),
                    )
                  }
                />
                <span>
                  {LABELS[scope]} <code>({scope})</code>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="muted small">
            Select only the permissions your integration needs. Wallet transfers and refund
            execution still require the wallet’s approval.
          </p>
          <Button
            type="submit"
            disabled={action.busy || !!issued || !name.trim() || scopes.length === 0}
          >
            {action.busy && !revoking ? 'Creating…' : `Create ${mode} key`}
          </Button>
        </form>
      </section>
      <section className="card stack">
        <div className="row">
          <h2>Your {mode} keys</h2>
          <Button variant="secondary" onClick={() => void keys.reload()} disabled={action.busy}>
            Refresh keys
          </Button>
        </div>
        {!keys.data ? (
          !keys.error && <Spinner label="Loading API keys" />
        ) : keys.data.api_keys.length === 0 ? (
          <p className="muted">No API keys in {mode} mode yet.</p>
        ) : (
          <ul className="list">
            {keys.data.api_keys.map((key) => (
              <li key={key.id}>
                <div className="grow stack">
                  <strong>{key.name}</strong>
                  <code className="address">{key.prefix}…</code>
                  <span className="small muted">
                    {key.kind} · {key.revoked_at ? 'Revoked' : 'Active'} · Created{' '}
                    {new Date(key.created_at).toLocaleDateString()} ·{' '}
                    {key.last_used_at
                      ? `Last used ${new Date(key.last_used_at).toLocaleString()}`
                      : 'Never used'}
                  </span>
                  <span className="small address">{key.scopes.join(', ') || 'No permissions'}</span>
                  {!key.revoked_at &&
                    (revoking === key.id ? (
                      <div className="stack">
                        <p>
                          Revoke “{key.name}”? Integrations using this key will lose API access.
                        </p>
                        <div className="row">
                          <Button disabled={action.busy} onClick={() => void revoke(key.id)}>
                            Confirm revoke
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={action.busy}
                            onClick={() => setRevoking(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        disabled={action.busy}
                        onClick={() => setRevoking(key.id)}
                      >
                        Revoke {key.name}
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
