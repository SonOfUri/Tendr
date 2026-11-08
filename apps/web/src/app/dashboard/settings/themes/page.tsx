'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { can } from '@tendr/contracts';
import { Alert, Button, Spinner } from '@tendr/ui';
import { Palette, WifiOff } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad } from '@/components/dashboard/common';
import { EmptyState, ErrorState, PageHeader, Panel, Select } from '@/components/dashboard/ui';
import { api } from '@/lib/api';
import { draftDirty, themeInUseMessage, type ThemeList, type ThemeObject } from '@/lib/themes';
import { withStepUp } from '@/lib/webauthn';

type PresetList = { data: { id: string; label: string }[] };

export default function ThemesPage() {
  const router = useRouter();
  const { store, uiPreview } = useDashboard();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [siteName, setSiteName] = useState('');
  const [name, setName] = useState('');
  const [from, setFrom] = useState<'blank' | string>('blank');
  const action = useAction();

  const list = useLoad(
    () => api<ThemeList>('/v1/themes?limit=50'),
    uiPreview || !store ? null : store.id,
  );
  const presets = useLoad(
    () => api<PresetList>('/v1/themes/presets'),
    uiPreview || !store ? null : `presets:${store.id}`,
  );

  if (!store) return null;

  const canWrite = can(store.role, 'settings:manage');
  const themes = list.data?.data ?? [];

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const body =
      from === 'blank'
        ? { name: name.trim(), from: 'blank' as const }
        : { name: name.trim(), from: { preset: from } };
    const created = await action.run(() =>
      api<ThemeObject>('/v1/themes', { method: 'POST', json: body }),
    );
    if (!created) return;
    setName('');
    setFrom('blank');
    setCreating(false);
    await list.reload();
  }

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    const body: { url: string; name?: string } = { url: siteUrl.trim() };
    if (siteName.trim()) body.name = siteName.trim();
    const created = await action.run(() =>
      api<ThemeObject>('/v1/themes/from-website', { method: 'POST', json: body }),
    );
    if (!created) return;
    router.push(`/dashboard/settings/themes/${created.id}`);
  }

  async function remove(theme: ThemeObject) {
    if (!window.confirm(`Delete "${theme.name}"? This cannot be undone.`)) return;
    const ok = await action.run(async () => {
      try {
        return await api(`/v1/themes/${theme.id}`, { method: 'DELETE' });
      } catch (err) {
        const inUse = themeInUseMessage(err);
        throw inUse ? new Error(inUse) : err;
      }
    });
    if (ok !== undefined) await list.reload();
  }

  async function publish(theme: ThemeObject) {
    if (
      !window.confirm(
        `Publish "${theme.name}"?\n\nThemes apply to this whole business (test and live): this changes the checkout live shoppers see wherever this theme is used.`,
      )
    ) {
      return;
    }
    const id = theme.id;
    const ok = await action.run(() =>
      withStepUp(() => api(`/v1/themes/${id}/publish`, { method: 'POST', json: {} })),
    );
    if (ok !== undefined) await list.reload();
  }

  async function makeDefault(theme: ThemeObject) {
    if (
      !window.confirm(
        `Make "${theme.name}" the default?\n\nIt applies to every checkout without a theme of its own, in test and live.`,
      )
    ) {
      return;
    }
    const id = theme.id;
    const ok = await action.run(() =>
      withStepUp(() => api(`/v1/themes/${id}/default`, { method: 'POST', json: {} })),
    );
    if (ok !== undefined) await list.reload();
  }

  return (
    <>
      <PageHeader
        title="Checkout themes"
        description="Themes apply to this whole business across test and live. Drafts stay private until you publish; make-default needs a passkey step-up."
        actions={
          canWrite && !uiPreview ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setImporting((v) => !v);
                  setCreating(false);
                  action.setError(null);
                }}
              >
                {importing ? 'Cancel' : 'From website'}
              </Button>
              <Button
                onClick={() => {
                  setCreating((v) => !v);
                  setImporting(false);
                  action.setError(null);
                }}
              >
                {creating ? 'Cancel' : 'New theme'}
              </Button>
            </>
          ) : null
        }
      />

      {uiPreview ? (
        <Panel>
          <EmptyState
            icon={<WifiOff size={22} strokeWidth={1.75} />}
            title="API offline"
            description="Start Postgres, Redis, and the Tendr API to manage checkout themes."
          />
        </Panel>
      ) : (
        <>
          {importing && canWrite ? (
            <Panel title="Create from website">
              <form className="stack" onSubmit={(e) => void onImport(e)}>
                <p className="dash-muted dash-small">
                  Tendr reads the site logo and colours to start a draft. You review it before
                  anything is published.
                </p>
                <label className="field">
                  <span>Website URL</span>
                  <input
                    required
                    type="url"
                    maxLength={2048}
                    pattern="https://.*"
                    value={siteUrl}
                    onChange={(e) => setSiteUrl(e.target.value)}
                    placeholder="https://example.com"
                  />
                </label>
                <label className="field">
                  <span>Theme name (optional)</span>
                  <input
                    maxLength={80}
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    placeholder="Checkout look"
                  />
                </label>
                <div className="actions">
                  <Button type="submit" disabled={action.busy}>
                    {action.busy ? 'Reading site…' : 'Create draft'}
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}

          {creating && canWrite ? (
            <Panel title="New theme">
              <form className="stack" onSubmit={(e) => void onCreate(e)}>
                <label className="field">
                  <span>Name</span>
                  <input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Checkout look"
                  />
                </label>
                <div className="field">
                  <span>Start from</span>
                  <Select
                    ariaLabel="Start from"
                    className="tendr-select--field"
                    value={from}
                    onChange={setFrom}
                    options={[
                      { value: 'blank', label: 'Blank' },
                      ...(presets.data?.data ?? [])
                        .filter((p) => p.id !== 'blank')
                        .map((p) => ({ value: p.id, label: `Preset — ${p.label}` })),
                    ]}
                  />
                </div>
                <div className="actions">
                  <Button type="submit" disabled={action.busy}>
                    {action.busy ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}

          <Panel
            title="Themes"
            action={<span className="dash-muted dash-small">Business-wide · not mode-scoped</span>}
          >
            {list.error ? (
              <ErrorState message={list.error} onRetry={() => void list.reload()} />
            ) : !list.data ? (
              <Spinner label="Loading themes" />
            ) : themes.length === 0 ? (
              <EmptyState
                icon={<Palette size={22} strokeWidth={1.75} />}
                title="No custom themes"
                description="Start from a preset or a blank draft. Publish only when the checkout look is ready."
                action={
                  canWrite ? (
                    <button type="button" className="dash-empty-cta" onClick={() => setCreating(true)}>
                      New theme
                    </button>
                  ) : null
                }
              />
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Default</th>
                      <th>Draft</th>
                      <th>Links</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {themes.map((theme) => {
                      const dirty = draftDirty(theme);
                      return (
                        <tr key={theme.id}>
                          <td>
                            <Link
                              href={`/dashboard/settings/themes/${theme.id}`}
                              className="dash-text-link"
                            >
                              <strong>{theme.name}</strong>
                            </Link>
                            <div className="dash-muted dash-small dash-mono">{theme.id}</div>
                          </td>
                          <td>
                            <span
                              className="dash-pill"
                              data-tone={theme.status === 'published' ? 'ok' : 'warn'}
                            >
                              {theme.status}
                            </span>
                          </td>
                          <td>{theme.is_default ? 'Yes' : '—'}</td>
                          <td className="dash-muted">{dirty ? 'Unpublished edits' : 'In sync'}</td>
                          <td className="dash-muted">{theme.used_by_links}</td>
                          <td>
                            <div className="actions">
                              <Link
                                href={`/dashboard/settings/themes/${theme.id}`}
                                className="dash-text-link"
                              >
                                {canWrite ? 'Edit' : 'View'}
                              </Link>
                              {canWrite && dirty ? (
                                <Button
                                  variant="secondary"
                                  disabled={action.busy}
                                  onClick={() => void publish(theme)}
                                >
                                  Publish
                                </Button>
                              ) : null}
                              {canWrite && theme.status === 'published' && !theme.is_default ? (
                                <Button
                                  variant="secondary"
                                  disabled={action.busy}
                                  onClick={() => void makeDefault(theme)}
                                >
                                  Make default
                                </Button>
                              ) : null}
                              {canWrite && !theme.is_default ? (
                                <Button
                                  variant="ghost"
                                  disabled={action.busy}
                                  onClick={() => void remove(theme)}
                                >
                                  Delete
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
