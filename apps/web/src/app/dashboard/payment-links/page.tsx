'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { can } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { api, errorMessage, type StoreContext } from '@/lib/api';
import { chainLabel } from '@/lib/assets';
import {
  AVAILABILITY,
  type DashboardPaymentLink,
  type PaymentLinkList,
} from '@/lib/dashboard-payment-links';
import { PaymentLinkForm } from './PaymentLinkForm';
import styles from './links.module.css';

export default function PaymentLinksPage() {
  const { store, context } = useDashboard();
  if (!store || !context) return null;
  return (
    <PaymentLinks
      key={`${context.merchantId}:${context.livemode}:${store.role}`}
      context={context}
      canWrite={can(store.role, 'money:request')}
    />
  );
}

/** Remount when the store or mode changes, so forms and in-flight results stay in their scope. */
function PaymentLinks({ context, canWrite }: { context: StoreContext; canWrite: boolean }) {
  const [links, setLinks] = useState<DashboardPaymentLink[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<DashboardPaymentLink | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(
    async (after?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setLoadError(null);
      try {
        const query = new URLSearchParams({ limit: '20', include_archived: String(showArchived) });
        if (after) query.set('starting_after', after);
        const result = await api<PaymentLinkList>(`/v1/payment_links?${query}`, {
          store: context,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setLinks((current) =>
          after
            ? [
                ...current,
                ...result.data.filter((link) => !current.some((old) => old.id === link.id)),
              ]
            : result.data,
        );
        setHasMore(result.has_more);
      } catch (err) {
        if (!controller.signal.aborted) setLoadError(errorMessage(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [context, showArchived],
  );

  useEffect(() => {
    void load();
    return () => {
      request.current?.abort();
    };
  }, [load]);

  async function archive(link: DashboardPaymentLink) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await api(`/v1/payment_links/${link.id}`, {
        method: link.archived ? 'PATCH' : 'DELETE',
        store: context,
        ...(link.archived ? { json: { archived: false } } : {}),
      });
      setNotice(
        link.archived
          ? `Restored “${link.title}”.`
          : `Archived “${link.title}”. Enable “Show archived links” to restore it.`,
      );
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  async function copy(link: DashboardPaymentLink) {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(link.url);
      setNotice(`Copied the ${context.livemode ? 'live' : 'test'} link for “${link.title}”.`);
    } catch {
      setActionError('Copy was unavailable. Select and copy the URL shown on the link.');
    }
  }

  return (
    <div className="stack">
      <div className={`row ${styles.header}`}>
        <div className="grow">
          <h1>Payment links</h1>
          <p className="muted">
            Create a checkout page and share its URL or QR code. These are your{' '}
            {context.livemode ? 'live' : 'test'} links.
          </p>
        </div>
        {canWrite && !editor && (
          <Button
            disabled={busy}
            onClick={() => {
              setEditor('new');
              setNotice(null);
              setActionError(null);
            }}
          >
            Create payment link
          </Button>
        )}
      </div>
      {!canWrite && (
        <p className="muted">
          Your viewer role can browse and share links. An owner, admin or finance member can create
          and edit them.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {actionError && <Alert tone="danger">{actionError}</Alert>}
      {editor && canWrite && (
        <PaymentLinkForm
          key={editor === 'new' ? 'new' : editor.id}
          context={context}
          existing={editor === 'new' ? undefined : editor}
          onCancel={() => setEditor(null)}
          onSaved={(link) => {
            setNotice(
              editor === 'new'
                ? `Created “${link.title}”. Your shareable URL is below.`
                : `Saved “${link.title}”.`,
            );
            setEditor(null);
            // Show the saved result immediately, even if refreshing the list fails.
            setLinks((current) => [link, ...current.filter((old) => old.id !== link.id)]);
            void load();
          }}
        />
      )}
      <section className="stack" aria-label="Your payment links">
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={showArchived}
              disabled={loading || busy}
              onChange={(e) => {
                setLinks([]);
                setHasMore(false);
                setShowArchived(e.target.checked);
              }}
            />{' '}
            Show archived links
          </label>
          <Button variant="secondary" disabled={loading || busy} onClick={() => void load()}>
            Refresh links
          </Button>
        </div>
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {loading && <Spinner label="Loading payment links" />}
        {!loading && !loadError && links.length === 0 && (
          <div className="card">
            <p>
              No payment links yet.{' '}
              {canWrite
                ? 'Create one to get a shareable checkout URL.'
                : 'Links created by your team will appear here.'}
            </p>
          </div>
        )}
        <ul className={`${styles.links} stack`}>
          {links.map((link) => (
            <li key={link.id}>
              <article className={`card ${styles.link}`} aria-label={link.title}>
                <div className="row">
                  <h3 className="grow">{link.title}</h3>
                  <span
                    className="status"
                    data-status={link.availability === 'available' ? 'active' : link.availability}
                  >
                    {AVAILABILITY[link.availability]}
                  </span>
                </div>
                {link.description && <p className="muted">{link.description}</p>}
                <p>
                  {link.amount_type === 'fixed'
                    ? `${link.amount} ${link.currency}`
                    : `Customer chooses amount${link.min_amount ? ` · Minimum ${link.min_amount} ${link.currency}` : ` (${link.currency})`}`}
                  <span className="muted">
                    {' '}
                    · {link.use_count}
                    {link.max_uses ? ` / ${link.max_uses}` : ''} payments
                  </span>
                </p>
                {link.expires_at && (
                  <p className="muted small">
                    Expires {new Date(link.expires_at).toLocaleString()}
                  </p>
                )}
                <p className="muted small">
                  Settlement:{' '}
                  {link.settlement_asset
                    ? `${link.settlement_symbol ?? link.settlement_asset}${link.settlement_chain ? ` · ${chainLabel(link.settlement_chain)}` : ''} into your Tendr account`
                    : 'Store default'}
                </p>
                <a
                  className="address small"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.url}
                </a>
                {link.availability === 'merchant_not_ready' && (
                  <p className="muted small">
                    This link is saved.{' '}
                    {link.settlement_asset ? (
                      'Check your '
                    ) : (
                      <>
                        Finish your <Link href="/dashboard/settings/payout">payout setup</Link> and
                        check your{' '}
                      </>
                    )}
                    <Link href="/dashboard">account status</Link> before accepting payments.
                  </p>
                )}
                <div className="row">
                  <Button variant="secondary" onClick={() => void copy(link)}>
                    Copy link
                  </Button>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    Open checkout
                  </a>
                  <a href={link.qr_url} target="_blank" rel="noopener noreferrer">
                    Open QR code
                  </a>
                  {canWrite && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={busy || editor !== null}
                        onClick={() => {
                          setEditor(link);
                          setNotice(null);
                          setActionError(null);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy || editor !== null}
                        onClick={() => void archive(link)}
                      >
                        {link.archived ? 'Restore' : 'Archive'}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            </li>
          ))}
        </ul>
        {hasMore && links.length > 0 && (
          <Button
            variant="secondary"
            disabled={loading || busy}
            onClick={() => void load(links[links.length - 1]!.id)}
          >
            Load more links
          </Button>
        )}
      </section>
    </div>
  );
}
