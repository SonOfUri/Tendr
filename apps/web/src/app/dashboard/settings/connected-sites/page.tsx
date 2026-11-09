'use client';

// Connected sites (WooCommerce plugin spec §2.7): every site connected through Connect, with who
// connected it and when it was last used. Remove revokes its keys and webhook endpoints (owner or
// admin, with a passkey step-up).
import { useState } from 'react';
import type { ConnectedSite } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { withStepUp } from '@/lib/webauthn';

const PLATFORMS: Record<string, { label: string; logo: string }> = {
  woocommerce: { label: 'WooCommerce', logo: '/plugins/woocommerce.svg' },
  shopify: { label: 'Shopify', logo: '/plugins/shopify.svg' },
};

function platformMeta(platform: string) {
  return PLATFORMS[platform] ?? { label: platform, logo: '' };
}

export default function ConnectedSitesPage() {
  const { store, context } = useDashboard();
  const canManage = store?.role === 'owner' || store?.role === 'admin';
  const sites = useLoad(
    () => api<{ connections: ConnectedSite[] }>('/v1/connections'),
    context && canManage ? context.merchantId : null,
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const { busy, setError, run } = useAction();

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
          <PageSkeleton label="Loading connected sites" />
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

      <div className="conn-supported" aria-label="Supported integrations">
        <span className="conn-supported-label">Works with</span>
        <span className="conn-supported-logos">
          <img src="/plugins/woocommerce.svg" alt="WooCommerce" width={28} height={28} />
          <img src="/plugins/shopify.svg" alt="Shopify" width={28} height={28} />
        </span>
      </div>

      <Panel title="Connected">
        {active.length === 0 ? (
          <EmptyState
            title="No sites are connected"
            description={
              <>
                In your store admin, open the tendr plugin and choose <em>Connect to tendr</em>.
                WooCommerce is live today; Shopify uses the same Connect flow when enabled.
              </>
            }
          />
        ) : (
          <div className="conn-grid">
            {active.map((c) => (
              <article key={c.id} className="conn-card" data-confirming={confirming === c.id ? 'true' : 'false'}>
                <SiteCardBody site={c} />
                {confirming === c.id ? (
                  <div className="conn-card-confirm">
                    <Alert tone="warning">
                      Removing <strong>{c.site_url}</strong> revokes its keys and webhook endpoints
                      straight away: the site can no longer take tendr payments or refunds. Its
                      checkout domain is removed only if this connection added it and no other
                      connected site uses it. A domain you added yourself in Checkout settings
                      stays.
                    </Alert>
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
                  <div className="conn-card-actions">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setError(null);
                        setConfirming(c.id);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Panel>

      {revoked.length > 0 && (
        <Panel title="Removed">
          <div className="conn-grid">
            {revoked.map((c) => (
              <article key={c.id} className="conn-card conn-card--revoked">
                <SiteCardBody site={c} />
              </article>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function SiteCardBody({ site }: { site: ConnectedSite }) {
  const meta = platformMeta(site.platform);
  const host = (() => {
    try {
      return new URL(site.site_url).host;
    } catch {
      return site.site_url;
    }
  })();

  return (
    <div className="conn-card-body">
      <div className="conn-card-head">
        <span className="conn-card-logo" aria-hidden>
          {meta.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={meta.logo} alt="" width={36} height={36} />
          ) : (
            <span className="conn-card-fallback">{meta.label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <div className="conn-card-meta">
          <strong className="conn-card-host" title={site.site_url}>
            {host}
          </strong>
          <span className="conn-card-platform">{meta.label}</span>
        </div>
      </div>
      <dl className="conn-card-facts">
        <div>
          <dt>Connected by</dt>
          <dd>{site.connected_by.email}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>{new Date(site.created_at).toLocaleDateString()}</dd>
        </div>
        <div>
          <dt>Last used</dt>
          <dd>{site.last_used_at ? new Date(site.last_used_at).toLocaleString() : 'Never'}</dd>
        </div>
      </dl>
      <p className="conn-card-url dash-mono" title={site.site_url}>
        {site.site_url}
      </p>
    </div>
  );
}
