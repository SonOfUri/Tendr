'use client';

// Connected sites (WooCommerce plugin spec §2.7): every site connected through Connect, with who
// connected it and when it was last used. Remove revokes its keys and webhook endpoints (owner or
// admin, with a passkey step-up).
import { useState } from 'react';
import type { ConnectedSite } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

const PLATFORMS: Record<string, string> = { woocommerce: 'WooCommerce' };

export default function ConnectedSitesPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const sites = useLoad(
    () => api<{ connections: ConnectedSite[] }>('/v1/connections'),
    context && canManage ? context.merchantId : null,
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  const header = (
    <PageHeader
      title="Connected sites"
      description={
        <>
          Sites connected with the tendr plugin. Each site has its own keys and webhook endpoints
          and gets only its own payment updates. They share this business’s account, money and
          settings.
        </>
      }
    />
  );

  if (!store || !context) return null;
  if (!canManage) {
    return (
      <div className="stack">
        {header}
        <Alert tone="info">Only owners and admins manage connected sites.</Alert>
      </div>
    );
  }
  if (!sites.data) {
    return (
      <div className="stack">
        {header}
        {sites.error ? (
          <ErrorState message={sites.error} onRetry={() => void sites.reload()} />
        ) : (
          <Spinner label="Loading connected sites" />
        )}
      </div>
    );
  }

  const active = sites.data.connections.filter((c) => c.status === 'active');
  const revoked = sites.data.connections.filter((c) => c.status === 'revoked');

  async function remove(site: ConnectedSite) {
    setRemoved(null);
    const res = await run(() =>
      withStepUp(() => api(`/v1/connections/${encodeURIComponent(site.id)}`, { method: 'DELETE' })),
    );
    if (res !== undefined) {
      setConfirming(null);
      setRemoved(site.site_url);
      await sites.reload();
    }
  }

  return (
    <div className="stack">
      {header}
      {removed && <Alert tone="success">{removed} is no longer connected.</Alert>}
      <Panel title="Connected">
        {active.length === 0 ? (
          <EmptyState
            title="No sites are connected"
            description={
              <>
                In your site’s admin, open WooCommerce → Settings → Payments → tendr and choose{' '}
                <em>Connect to tendr</em>.
              </>
            }
          />
        ) : (
          <ul className="list">
            {active.map((c) => (
              <li key={c.id}>
                <SiteRow site={c} />
                {confirming === c.id ? (
                  <div className="form">
                    <Alert tone="warning">
                      Removing <strong>{c.site_url}</strong> revokes its keys and webhook endpoints
                      straight away: the site can no longer take tendr payments or refunds. Its
                      checkout domain is removed only if this connection added it and no other
                      connected site uses it. A domain you added yourself in Checkout settings
                      stays.
                    </Alert>
                    {error && <Alert tone="danger">{error}</Alert>}
                    <div className="button-row">
                      <Button onClick={() => void remove(c)} disabled={busy}>
                        {busy ? 'Waiting for your passkey…' : 'Remove site'}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          setError(null);
                        }}
                      >
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setError(null);
                      setConfirming(c.id);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {revoked.length > 0 && (
        <Panel title="Removed">
          <ul className="list">
            {revoked.map((c) => (
              <li key={c.id}>
                <SiteRow site={c} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function SiteRow({ site }: { site: ConnectedSite }) {
  return (
    <span className="grow">
      <strong className="dash-mono">{site.site_url}</strong>
      <br />
      <span className="dash-muted dash-small">
        {PLATFORMS[site.platform] ?? site.platform} · connected by {site.connected_by.email} on{' '}
        {new Date(site.created_at).toLocaleDateString()} · last used{' '}
        {site.last_used_at ? new Date(site.last_used_at).toLocaleString() : 'never'}
      </span>
    </span>
  );
}
