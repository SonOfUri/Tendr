'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { can } from '@tendr/contracts';
import { Alert, Button } from '@tendr/ui';
import { PageSkeleton } from '@/components/dashboard/Skeleton';
import { WifiOff } from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useLoad } from '@/components/dashboard/common';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Select,
  TextLink,
} from '@/components/dashboard/ui';
import { toast } from '@/components/toast';
import { api, errorMessage } from '@/lib/api';
import {
  PALETTE_KEYS,
  PALETTE_LABELS,
  HEX_RE,
  draftDirty,
  ensurePalettes,
  mapProblems,
  requiredSchemes,
  sameDocument,
  themeProblems,
  withCustomCss,
  withSettings,
  type MappedProblems,
  type PaletteKey,
  type ThemeAssetList,
  type ThemeAssetObject,
  type ThemeMode,
  type ThemeObject,
  type ThemePreviewResult,
  type ThemeProblem,
  type ThemeScheme,
  type ThemeSettings,
} from '@/lib/themes';
import { livePreviewRead } from '@/lib/theme/live-preview';
import { PreviewBody } from '@/app/preview/theme/[token]/ThemePreview';
import { withStepUp } from '@/lib/webauthn';

const MODE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto (follow the shopper)' },
];

const SCHEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const EMPTY: MappedProblems = { fields: {}, other: [] };

type Busy = 'save' | 'validate' | 'preview' | 'publish' | 'default' | 'upload' | null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function ThemeEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { store, uiPreview } = useDashboard();

  const loaded = useLoad(
    () => api<ThemeObject>(`/v1/themes/${id}`),
    uiPreview || !store ? null : `theme:${store.id}:${id}`,
  );

  if (!store) return null;
  const canWrite = can(store.role, 'settings:manage');

  return (
    <>
      <PageHeader
        title="Edit theme"
        description="Themes apply to this whole business across test and live. Publishing changes what live shoppers see."
        actions={<TextLink href="/dashboard/settings/themes">All themes</TextLink>}
      />
      {uiPreview ? (
        <Panel>
          <EmptyState
            icon={<WifiOff size={22} strokeWidth={1.75} />}
            title="API offline"
            description="Start Postgres, Redis, and the Tendr API to edit checkout themes."
          />
        </Panel>
      ) : loaded.error ? (
        <Panel>
          <ErrorState message={loaded.error} onRetry={() => void loaded.reload()} />
        </Panel>
      ) : !loaded.data ? (
        <Panel>
          <PageSkeleton label="Loading theme" />
        </Panel>
      ) : (
        <Editor
          // A fresh editor per theme id; after a save the same instance takes the response.
          key={loaded.data.id}
          initial={loaded.data}
          canWrite={canWrite}
          storeId={store.id}
          merchantName={store.name}
        />
      )}
    </>
  );
}

function Editor({
  initial,
  canWrite,
  storeId,
  merchantName,
}: {
  initial: ThemeObject;
  canWrite: boolean;
  storeId: string;
  merchantName: string;
}) {
  const [theme, setTheme] = useState<ThemeObject>(initial);
  const [name, setName] = useState(initial.name);
  const [settings, setSettings] = useState<ThemeSettings>(initial.draft.settings);
  const [css, setCss] = useState(initial.draft.custom_css ?? '');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<MappedProblems>(EMPTY);
  const [preview, setPreview] = useState<ThemePreviewResult | null>(null);
  const [previewScheme, setPreviewScheme] = useState<ThemeScheme>('light');
  const fileRef = useRef<HTMLInputElement>(null);

  const assets = useLoad(() => api<ThemeAssetList>('/v1/theme-assets'), `assets:${storeId}`);

  // The document the form describes: the saved draft with these settings and CSS (blocks and
  // success blocks are never touched here, so saving settings keeps them as they are).
  const document = useMemo(
    () => withCustomCss(withSettings(theme.draft, settings), css),
    [theme.draft, settings, css],
  );
  const unsaved = name.trim() !== theme.name || !sameDocument(document, theme.draft);
  const publishable = draftDirty(theme);
  const disabled = !canWrite || busy !== null;

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!unsaved) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [unsaved]);

  function takeTheme(next: ThemeObject) {
    setTheme(next);
    setName(next.name);
    setSettings(next.draft.settings);
    setCss(next.draft.custom_css ?? '');
  }

  async function run(kind: Exclude<Busy, null>, fn: () => Promise<void>) {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      const list = themeProblems(err);
      if (list) {
        setProblems(mapProblems(list));
        toast.error('The theme has problems. Fix the highlighted fields; your entries are kept.');
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run('save', async () => {
      const body: { name?: string; draft?: unknown } = {};
      if (name.trim() !== theme.name) body.name = name.trim();
      if (!sameDocument(document, theme.draft)) body.draft = document;
      const next = await api<ThemeObject>(`/v1/themes/${theme.id}`, {
        method: 'PATCH',
        json: body,
      });
      setProblems(EMPTY);
      takeTheme(next);
      setNotice('Draft saved. Shoppers see nothing new until you publish.');
    });

  const validate = () =>
    run('validate', async () => {
      const r = await api<{ valid: boolean; problems: ThemeProblem[] }>('/v1/themes/validate', {
        method: 'POST',
        json: { document },
      });
      setProblems(mapProblems(r.problems));
      if (r.valid) setNotice('No problems found. This is not saved yet.');
      else toast.error('The theme has problems. Fix the highlighted fields.');
    });

  const openPreview = () =>
    run('preview', async () => {
      const r = await api<ThemePreviewResult>(`/v1/themes/${theme.id}/preview`, {
        method: 'POST',
        json: { sample: 'checkout', scheme: previewScheme, viewport: 'desktop' },
      });
      setPreview(r);
      // Popup blockers may refuse this (we are past an await); the link below always works.
      window.open(r.url, '_blank', 'noopener,noreferrer');
    });

  const publish = () => {
    const ok = window.confirm(
      `Publish "${theme.name}"?\n\nThemes apply to this whole business, so this changes the checkout live shoppers see wherever this theme is used, in test and live. Only the saved draft is published.`,
    );
    if (!ok) return;
    return run('publish', async () => {
      const next = await withStepUp(() =>
        api<ThemeObject>(`/v1/themes/${theme.id}/publish`, { method: 'POST', json: {} }),
      );
      setProblems(EMPTY);
      takeTheme(next);
      setNotice('Published. Live checkouts now use this version.');
    });
  };

  const makeDefault = () => {
    const ok = window.confirm(
      `Make "${theme.name}" the default theme?\n\nThe default applies to every payment link and checkout without a theme of its own, in test and live.`,
    );
    if (!ok) return;
    return run('default', async () => {
      const next = await withStepUp(() =>
        api<ThemeObject>(`/v1/themes/${theme.id}/default`, { method: 'POST', json: {} }),
      );
      setTheme((t) => ({ ...t, ...next, draft: t.draft }));
      setNotice('This is now the default theme.');
    });
  };

  const upload = (file: File) =>
    run('upload', async () => {
      const formData = new FormData();
      formData.set('kind', 'logo');
      formData.set('file', file);
      const asset = await api<ThemeAssetObject>('/v1/theme-assets', { method: 'POST', formData });
      // Merge immediately so the live preview can resolve the logo without waiting on reload.
      assets.setData((prev) => {
        const rows = prev?.data ?? [];
        const next = [asset, ...rows.filter((a) => a.id !== asset.id)];
        return { data: next };
      });
      setSettings((s) => ({ ...s, logo_asset_id: asset.id }));
      void assets.reload();
      setNotice('Logo uploaded and selected. Save the draft to keep it.');
    }).finally(() => {
      if (fileRef.current) fileRef.current.value = '';
    });

  function setMode(mode: ThemeMode) {
    setSettings((s) => ensurePalettes({ ...s, mode }));
  }

  function setColor(scheme: ThemeScheme, key: PaletteKey, value: string) {
    setSettings((s) => {
      const withPalette = ensurePalettes({ ...s, mode: s.mode });
      const palette = withPalette.palettes[scheme] ?? {
        background: '#ffffff',
        surface: '#f5f5f5',
        text: '#111111',
        accent: '#111111',
      };
      return {
        ...withPalette,
        palettes: { ...withPalette.palettes, [scheme]: { ...palette, [key]: value } },
      };
    });
  }

  const f = problems.fields;
  const logos = (assets.data?.data ?? []).filter((a) => a.kind === 'logo');
  const currentLogo = (assets.data?.data ?? []).find((a) => a.id === settings.logo_asset_id);
  const liveRead = useMemo(
    () =>
      livePreviewRead({
        themeId: theme.id,
        version: theme.version,
        document,
        css: css.trim() ? css : null,
        assets: assets.data?.data ?? [],
        merchantName,
        scheme: previewScheme,
        viewport: 'desktop',
      }),
    [theme.id, theme.version, document, css, assets.data?.data, merchantName, previewScheme],
  );

  return (
    <>
      {!canWrite ? (
        <Alert tone="info">You can view this theme. Editing needs the settings permission.</Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {problems.other.length > 0 ? (
        <Alert tone="warning">
          <strong>Other problems</strong>
          <ul className="dash-theme-problems">
            {problems.other.map((p, i) => (
              <li key={`${p.path}:${i}`}>
                <span className="dash-mono dash-small">{p.path || 'document'}</span> — {p.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="theme-editor-split">
        <div className="theme-editor-form stack">
      <Panel
        title="Status"
        action={
          <span className="dash-muted dash-small dash-mono">
            {theme.id} · v{theme.version}
          </span>
        }
      >
        <div className="dash-theme-status">
          <span className="dash-pill" data-tone={theme.status === 'published' ? 'ok' : 'warn'}>
            {theme.status}
          </span>
          {theme.is_default ? (
            <span className="dash-pill" data-tone="ok">
              default
            </span>
          ) : null}
          <span className="dash-muted dash-small">
            {publishable ? 'Unpublished edits' : 'Published version matches the draft'}
            {unsaved ? ' · unsaved changes in this form' : ''}
            {theme.used_by_links > 0
              ? ` · used by ${theme.used_by_links} payment link${theme.used_by_links === 1 ? '' : 's'}`
              : ''}
          </span>
        </div>
      </Panel>

      <Panel title="Branding">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="field">
            <span>Theme name</span>
            <input
              value={name}
              maxLength={80}
              disabled={disabled}
              onChange={(e) => setName(e.target.value)}
            />
            {f.name ? <small className="dash-field-error">{f.name}</small> : null}
          </label>

          <label className="field">
            <span>Shown to shoppers as</span>
            <input
              value={settings.display_name}
              maxLength={80}
              disabled={disabled}
              onChange={(e) => setSettings((s) => ({ ...s, display_name: e.target.value }))}
            />
            {f.display_name ? <small className="dash-field-error">{f.display_name}</small> : null}
          </label>

          <div className="field">
            <span>Colour mode</span>
            <Select
              ariaLabel="Colour mode"
              className="tendr-select--field"
              value={settings.mode}
              options={MODE_OPTIONS}
              disabled={disabled}
              onChange={(v) => setMode(v as ThemeMode)}
            />
            {f.mode ? <small className="dash-field-error">{f.mode}</small> : null}
          </div>

          {requiredSchemes(settings.mode).map((scheme) => (
            <fieldset key={scheme} className="dash-theme-palette">
              <legend>{scheme === 'light' ? 'Light palette' : 'Dark palette'}</legend>
              {f[`palettes.${scheme}`] ? (
                <small className="dash-field-error">{f[`palettes.${scheme}`]}</small>
              ) : null}
              <div className="dash-theme-colors">
                {PALETTE_KEYS.map((key) => {
                  const value = settings.palettes[scheme]?.[key] ?? '';
                  const err = f[`palettes.${scheme}.${key}`];
                  return (
                    <label key={key} className="field">
                      <span>{PALETTE_LABELS[key]}</span>
                      <div className="dash-theme-color-row">
                        <input
                          type="color"
                          aria-label={`${scheme} ${PALETTE_LABELS[key]} colour`}
                          value={HEX_RE.test(value) ? value : '#000000'}
                          disabled={disabled}
                          onChange={(e) => setColor(scheme, key, e.target.value)}
                        />
                        <input
                          className="dash-mono"
                          value={value}
                          maxLength={7}
                          spellCheck={false}
                          disabled={disabled}
                          aria-invalid={err ? true : undefined}
                          onChange={(e) => setColor(scheme, key, e.target.value.trim())}
                        />
                      </div>
                      {err ? <small className="dash-field-error">{err}</small> : null}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <p className="dash-muted dash-small">
            Blocks, the thank-you page, fonts and corners are kept as they are in the draft. Saving
            here only changes the fields above and custom CSS.
          </p>

          <div className="actions">
            <Button type="submit" disabled={disabled || !unsaved}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => void validate()}
            >
              {busy === 'validate' ? 'Checking…' : 'Validate'}
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title="Logo">
        {assets.error ? (
          <ErrorState message={assets.error} onRetry={() => void assets.reload()} />
        ) : !assets.data ? (
          <PageSkeleton label="Loading files" rows={2} />
        ) : (
          <div className="stack">
            <p className="dash-small">
              Current logo:{' '}
              {currentLogo ? (
                <a href={currentLogo.url} target="_blank" rel="noopener noreferrer">
                  <span className="dash-mono">{currentLogo.id}</span>
                </a>
              ) : settings.logo_asset_id ? (
                <span className="dash-mono">{settings.logo_asset_id}</span>
              ) : (
                <span className="dash-muted">none</span>
              )}
              {f.logo_asset_id ? (
                <small className="dash-field-error"> {f.logo_asset_id}</small>
              ) : null}
            </p>
            {canWrite ? (
              <div className="actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  disabled={disabled}
                  aria-label="Upload logo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
                {settings.logo_asset_id ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      setSettings((s) => {
                        const { logo_asset_id: _drop, ...rest } = s;
                        return rest;
                      })
                    }
                  >
                    Remove logo
                  </Button>
                ) : null}
              </div>
            ) : null}
            <p className="dash-muted dash-small">
              Files are at most 2 MB and shared by every theme.
            </p>
            {logos.length === 0 ? (
              <p className="dash-muted dash-small">No logos uploaded yet.</p>
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Type</th>
                      <th>Size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {logos.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <a href={a.url} target="_blank" rel="noopener noreferrer">
                            <span className="dash-mono dash-small">{a.id}</span>
                          </a>
                        </td>
                        <td className="dash-muted">{a.mime}</td>
                        <td className="dash-muted">{formatBytes(a.size_bytes)}</td>
                        <td>
                          {canWrite ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={disabled || settings.logo_asset_id === a.id}
                              onClick={() => setSettings((s) => ({ ...s, logo_asset_id: a.id }))}
                            >
                              {settings.logo_asset_id === a.id ? 'In use' : 'Use'}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Custom CSS (advanced)">
        <div className="stack">
          <label className="field">
            <span>CSS</span>
            <textarea
              className="dash-mono"
              rows={8}
              spellCheck={false}
              value={css}
              disabled={disabled}
              onChange={(e) => setCss(e.target.value)}
              placeholder="/* Scoped to your checkout. At most 50 KB. */"
            />
            {f.custom_css ? <small className="dash-field-error">{f.custom_css}</small> : null}
          </label>
          <p className="dash-muted dash-small">
            Rules are scoped to your checkout and checked when you save or validate.
          </p>
        </div>
      </Panel>

      {canWrite ? (
        <Panel title="Go live">
          <div className="stack">
            <Alert tone="warning">
              Themes apply to this whole business, not per mode. Publishing replaces what live
              shoppers see for every payment link using this theme, and making it the default
              applies it to every link without its own theme. Both ask for your passkey.
            </Alert>
            <div className="actions">
              <Button
                type="button"
                disabled={disabled || unsaved || !publishable}
                onClick={() => void publish()}
              >
                {busy === 'publish' ? 'Publishing…' : 'Publish'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={disabled || theme.status !== 'published' || theme.is_default || unsaved}
                onClick={() => void makeDefault()}
              >
                {busy === 'default' ? 'Working…' : 'Make default'}
              </Button>
            </div>
            <p className="dash-muted dash-small">
              {unsaved
                ? 'Save your changes first: only the saved draft is published.'
                : !publishable
                  ? 'Nothing to publish: the published version already matches the draft.'
                  : theme.status !== 'published'
                    ? 'Publish once before making this the default.'
                    : 'Publishing uses the saved draft.'}
            </p>
          </div>
        </Panel>
      ) : null}

      <p className="dash-small">
        <Link href="/dashboard/settings/themes" className="dash-text-link">
          Back to themes
        </Link>
      </p>
        </div>

        <aside className="theme-editor-preview" aria-label="Live theme preview">
          <div className="theme-editor-preview-chrome">
            <div className="theme-editor-preview-title">
              <span>Live preview</span>
              {unsaved ? (
                <span className="dash-pill" data-tone="warn">
                  unsaved
                </span>
              ) : (
                <span className="dash-muted dash-small">Updates as you edit</span>
              )}
            </div>
            <div className="theme-editor-preview-controls">
              <Select
                ariaLabel="Preview colour scheme"
                className="tendr-select--field"
                value={previewScheme}
                options={SCHEME_OPTIONS}
                onChange={(v) => setPreviewScheme(v as ThemeScheme)}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void openPreview()}
              >
                {busy === 'preview' ? 'Creating link…' : 'Open in new tab'}
              </Button>
              {preview ? (
                <a
                  href={preview.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dash-text-link dash-small"
                >
                  Open again
                </a>
              ) : null}
            </div>
            <p className="dash-muted dash-small">
              New tab uses the saved draft
              {unsaved ? ' — save first to include unsaved changes' : ''}. Links expire after about
              15 minutes
              {preview ? ` (this one: ${new Date(preview.expires_at).toLocaleTimeString()})` : ''}.
            </p>
          </div>
          <div className="theme-editor-preview-canvas">
            <PreviewBody read={liveRead} embedded />
          </div>
        </aside>
      </div>
    </>
  );
}
