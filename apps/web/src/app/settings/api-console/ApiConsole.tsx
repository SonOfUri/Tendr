'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialDescriptorJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { api, currentCsrf, errorMessage, setCsrfToken, type Me } from '@/lib/api';
import { publicEnv } from '@/lib/env';
import { loginWithPasskey, registerPasskey, signChallenge, stepUp } from '@/lib/webauthn';
import {
  defaultAuth,
  endpoints,
  endpointNote,
  exampleBody,
  needsStore,
  type Endpoint,
} from '@/lib/api-console/catalog';
import {
  fillPath,
  pathParameters,
  prepareRequest,
  readResponse,
  type ConsoleAuth,
  type ConsoleRequest,
} from '@/lib/api-console/request';
import styles from './console.module.css';

interface Result {
  status: number;
  statusText: string;
  elapsed: number;
  text: string;
  headers: [string, string][];
  data: unknown;
  truncated: boolean;
  request: ConsoleRequest;
}
type History = { method: string; path: string; status: number; elapsed: number };
const initial = endpoints.find((e) => e.path === '/v1/health')!;
const groups = Array.from(new Set(endpoints.map((e) => e.group))).sort();
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export default function ApiConsole({ localMail = false }: { localMail?: boolean }) {
  const [endpoint, setEndpoint] = useState<Endpoint>(initial);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [method, setMethod] = useState(initial.method);
  const [path, setPath] = useState(initial.path);
  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [headers, setHeaders] = useState('{}');
  const [auth, setAuth] = useState<ConsoleAuth>('public');
  const [bearer, setBearer] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [livemode, setLivemode] = useState(false);
  const [storeHeaders, setStoreHeaders] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [csrfReady, setCsrfReady] = useState(false);
  const [multipart, setMultipart] = useState(false);
  const [file, setFile] = useState<File>();
  const [fileKey, setFileKey] = useState(0);
  const [assetKind, setAssetKind] = useState('image');
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showHeaders, setShowHeaders] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const filtered = endpoints.filter(
    (e) =>
      (!group || e.group === group) &&
      `${e.method} ${e.path} ${e.group} ${e.principals.join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  function select(e: Endpoint) {
    setEndpoint(e);
    setMethod(e.method);
    setPath(e.path);
    setParams({});
    setQuery(e.path.includes('/payment_links/public/') ? 'mode=test' : '');
    setBody(exampleBody(e));
    setAuth(defaultAuth(e));
    setStoreHeaders(needsStore(e));
    setMultipart(e.method === 'POST' && e.path === '/v1/theme-assets');
    setFile(undefined);
    setFileKey((n) => n + 1);
    setHeaders('{}');
    setError('');
    setNotice('');
    setResult(null);
  }

  function captureSession(data: unknown) {
    const d = object(data);
    if (typeof d.csrfToken === 'string') {
      setCsrfToken(d.csrfToken);
      setCsrfReady(true);
    }
    if (Array.isArray(d.stores) && object(d.user).email) {
      const m = data as Me;
      setMe(m);
      setMerchantId((old) => (m.stores.some((s) => s.id === old) ? old : (m.stores[0]?.id ?? '')));
    }
  }

  async function loadSession() {
    const m = await api<Me>('/v1/me', { store: false });
    captureSession(m);
    setCsrfReady(Boolean(currentCsrf()));
    setNotice(`Signed in as ${m.user.email}. Store list and CSRF token loaded.`);
  }

  async function helper(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setCsrfReady(Boolean(currentCsrf()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError('');
    setNotice('');
    setResult(null);
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const request: ConsoleRequest = {
        method,
        path: fillPath(path, params),
        query,
        auth,
        bearer,
        merchantId,
        livemode,
        storeHeaders,
        csrf: currentCsrf(),
        headers,
        body,
        file,
        assetKind,
        multipart,
        signingSecret,
      };
      const prepared = await prepareRequest(publicEnv.apiBaseUrl, request);
      const started = performance.now();
      const response = await fetch(prepared.url, { ...prepared.init, signal: abort.signal });
      const read = await readResponse(response);
      const elapsed = Math.round(performance.now() - started);
      let data: unknown;
      try {
        data = JSON.parse(read.text);
      } catch {
        data = undefined;
      }
      const contentType = response.headers.get('content-type') ?? '';
      const binary =
        /^(image|font|audio|video)\//.test(contentType) || contentType.includes('octet-stream');
      setResult({
        status: response.status,
        statusText: response.statusText,
        elapsed,
        text: binary
          ? `[Binary response: ${contentType}. Use the asset URL in a browser to view it.]`
          : read.text,
        data,
        headers: Array.from(response.headers.entries()),
        truncated: read.truncated,
        // Keep the request context for passkey follow-up, not copies of credentials or files.
        request: {
          ...request,
          bearer: '',
          signingSecret: '',
          csrf: null,
          file: undefined,
          headers: '{}',
        },
      });
      setHistory((old) =>
        [{ method, path: request.path, status: response.status, elapsed }, ...old].slice(0, 12),
      );
      if (response.ok && auth === 'session') captureSession(data);
      if (
        auth === 'session' &&
        (object(object(data).error).code === 'UNAUTHENTICATED' ||
          (response.ok && request.path === '/v1/auth/logout'))
      ) {
        setMe(null);
        setCsrfToken(null);
        setCsrfReady(false);
      }
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Request cancelled or timed out. A submitted write may still have completed; read its state before retrying.'
          : `${errorMessage(err)} If the API is running, check its CORS origin and this page’s configured API URL.`,
      );
    } finally {
      clearTimeout(timer);
      controller.current = null;
      setBusy(false);
    }
  }

  async function preparePasskey() {
    if (!result) return;
    const data = object(result.data);
    const previous = result.request;
    let response: unknown;
    let target: string;
    let extra: Record<string, unknown> = {};
    if (previous.path.startsWith('/v1/auth/passkeys/') && previous.path.endsWith('/options')) {
      if (previous.path.includes('/register/')) {
        response = await startRegistration({
          optionsJSON: result.data as PublicKeyCredentialCreationOptionsJSON,
        });
        const prior = object(JSON.parse(previous.body || '{}'));
        extra =
          typeof prior.recoveryToken === 'string' ? { recoveryToken: prior.recoveryToken } : {};
      } else
        response = await startAuthentication({
          optionsJSON: result.data as PublicKeyCredentialRequestOptionsJSON,
        });
      target = previous.path.replace(/\/options$/, '/verify');
    } else {
      response = await signChallenge(
        data.challengeB64u as string,
        data.allowCredentials as PublicKeyCredentialDescriptorJSON[],
      );
      const intent =
        object(JSON.parse(previous.body || '{}')).intent === 'cancel' ? 'cancel' : 'approve';
      target = previous.path.includes('/recovery/')
        ? previous.path.replace(/\/challenge$/, '/cancel')
        : previous.path.replace(/\/challenge$/, `/${intent}`);
    }
    const definition = endpoints.find(
      (e) =>
        e.method === 'POST' &&
        (e.path === target ||
          (target.includes('/proposals/') &&
            e.path === `/v1/account/proposals/:id/${target.split('/').at(-1)}`)),
    );
    if (definition) select(definition);
    setMethod('POST');
    setPath(target);
    setParams({});
    setQuery('');
    setAuth('session');
    setMerchantId(previous.merchantId);
    setLivemode(previous.livemode);
    setStoreHeaders(previous.storeHeaders);
    setBody(JSON.stringify({ response, ...extra }, null, 2));
    setResult(null);
    setNotice(
      'Passkey response prepared. Review the request, then press Send request to verify it.',
    );
  }

  function clearSensitive() {
    setPath(endpoint.path);
    setBearer('');
    setSigningSecret('');
    setBody('');
    setParams({});
    setQuery('');
    setHeaders('{}');
    setFile(undefined);
    setFileKey((n) => n + 1);
    setResult(null);
    setHistory([]);
    setCsrfToken(null);
    setCsrfReady(false);
    setNotice('Inputs and responses cleared. Your browser session remains signed in.');
  }

  const responseData = object(result?.data);
  const canSign = Boolean(
    result &&
    result.status >= 200 &&
    result.status < 300 &&
    ((result.request.path.startsWith('/v1/auth/passkeys/') &&
      result.request.path.endsWith('/options') &&
      typeof responseData.challenge === 'string') ||
      (result.request.path.endsWith('/challenge') &&
        typeof responseData.challengeB64u === 'string' &&
        Array.isArray(responseData.allowCredentials))),
  );

  return (
    <div className={styles.console}>
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Tendr · test tools</p>
          <h1>API console</h1>
          <p>{endpoints.length} endpoints. Pick a request, fill it in, inspect the response.</p>
        </div>
        <Link href="/dashboard">Open dashboard ↗</Link>
      </header>
      <div className={styles.target}>
        <strong>API</strong> <code>{publicEnv.apiBaseUrl}</code>
        <span>Credentials and responses stay in this page’s memory.</span>
      </div>
      <section className={styles.panel} aria-label="Session tools">
        <div className={styles.row}>
          <strong>{me ? me.user.email : 'No session loaded'}</strong>
          <span>{csrfReady ? 'CSRF ready' : 'Load your session before authenticated writes'}</span>
        </div>
        <div className={styles.row}>
          <button disabled={busy} onClick={() => void helper(loadSession)}>
            Load session
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void helper(async () => {
                await loginWithPasskey();
                await loadSession();
              })
            }
          >
            Sign in with passkey
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void helper(async () => {
                await registerPasskey({ deviceLabel: 'API console' });
                await loadSession();
              })
            }
          >
            Register passkey
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void helper(async () => {
                await stepUp();
                setNotice('Passkey confirmed. Send your protected request again.');
              })
            }
          >
            Step up
          </button>
          <Link href="/signup">New account</Link>
          {localMail && <Link href="/settings/local-mail">Local inbox</Link>}
          <button
            disabled={busy}
            onClick={() =>
              void helper(async () => {
                await api('/v1/auth/logout', { method: 'POST', json: {}, store: false });
                setMe(null);
                clearSensitive();
                setNotice('Signed out.');
              })
            }
          >
            Sign out
          </button>
        </div>
      </section>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className={styles.notice}>
          {notice}
        </div>
      )}
      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <label>
            Find an endpoint
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="payments, themes, POST…"
            />
          </label>
          <label>
            Group
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">All groups</option>
              {groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </label>
          <small>
            {filtered.length} of {endpoints.length} endpoints
          </small>
          <nav className={styles.routes} aria-label="API endpoints">
            {filtered.map((e) => (
              <button
                key={e.id}
                disabled={busy}
                aria-current={e.id === endpoint.id ? 'true' : undefined}
                onClick={() => select(e)}
              >
                <span className={styles.method} data-method={e.method}>
                  {e.method}
                </span>
                <span>{e.path}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div className={styles.editor}>
          <section className={styles.panel}>
            <h2>Request</h2>
            <p className={styles.contract}>
              Accepted principals: {endpoint.principals.join(', ')}
              {endpoint.permission ? ` · Permission: ${endpoint.permission}` : ''}
              {endpoint.scope ? ` · Key scope: ${endpoint.scope}` : ''}
              {endpoint.stepUp ? ' · Step-up required' : ''}
            </p>
            <p>{endpointNote(endpoint)}</p>
            <small>
              Contract:{' '}
              <code>
                {endpoint.source}:{endpoint.line}
              </code>
              . Service-level checks may add restrictions.
            </small>
            <fieldset disabled={busy} className={styles.fields}>
              <div className={styles.requestLine}>
                <label>
                  Method
                  <select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  API path
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    spellCheck={false}
                  />
                </label>
              </div>
              {pathParameters(path).map((name) => (
                <label key={name}>
                  Path parameter {name}
                  <input
                    value={params[name] ?? ''}
                    onChange={(e) => setParams((p) => ({ ...p, [name]: e.target.value }))}
                    spellCheck={false}
                    placeholder={name === '*' ? 'assets/mer_…/asset_….png' : `Enter ${name}`}
                  />
                </label>
              ))}
              <label>
                Query string
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="limit=20&starting_after=…"
                  spellCheck={false}
                />
              </label>
              <div className={styles.twoColumns}>
                <label>
                  Authentication
                  <select value={auth} onChange={(e) => setAuth(e.target.value as ConsoleAuth)}>
                    <option value="session">Browser session</option>
                    <option value="bearer">Bearer token</option>
                    <option value="public">Public / no credentials</option>
                  </select>
                </label>
                {auth === 'session' && (
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={storeHeaders}
                      onChange={(e) => setStoreHeaders(e.target.checked)}
                    />
                    Send store and mode headers
                  </label>
                )}
              </div>
              {auth === 'bearer' && (
                <>
                  <label>
                    Bearer token
                    <input
                      type="password"
                      autoComplete="off"
                      value={bearer}
                      onChange={(e) => setBearer(e.target.value)}
                      placeholder="Test secret key, publishable key, connection key, or session client secret"
                    />
                  </label>
                  <small>The token determines its own store and mode.</small>
                </>
              )}
              {auth === 'session' && storeHeaders && (
                <div className={styles.twoColumns}>
                  <label>
                    Merchant ID
                    <input
                      list="console-stores"
                      value={merchantId}
                      onChange={(e) => setMerchantId(e.target.value)}
                      placeholder="mer_…"
                    />
                    <datalist id="console-stores">
                      {me?.stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.role}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <label>
                    Mode
                    <select
                      value={String(livemode)}
                      onChange={(e) => setLivemode(e.target.value === 'true')}
                    >
                      <option value="false">Test</option>
                      <option value="true">Live</option>
                    </select>
                  </label>
                </div>
              )}
              {auth === 'session' && storeHeaders && livemode && (
                <p className={styles.live}>
                  Live mode selected. Requests act on real data where the API permits them.
                </p>
              )}
              <details>
                <summary>Extra headers and request signing</summary>
                <label>
                  Headers JSON
                  <textarea
                    rows={4}
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const h = Object.fromEntries(
                        new Headers(JSON.parse(headers || '{}')).entries(),
                      );
                      setHeaders(
                        JSON.stringify({ ...h, 'idempotency-key': crypto.randomUUID() }, null, 2),
                      );
                    } catch {
                      setError('Enter valid headers JSON first.');
                    }
                  }}
                >
                  New idempotency key
                </button>
                <label>
                  HMAC signing secret (optional)
                  <input
                    type="password"
                    autoComplete="off"
                    value={signingSecret}
                    onChange={(e) => setSigningSecret(e.target.value)}
                  />
                </label>
                <small>
                  Signs the exact request bytes as Tendr-Signature. Keep the same idempotency key
                  when retrying a create request.
                </small>
              </details>
              {writing && (
                <>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={multipart}
                      onChange={(e) => setMultipart(e.target.checked)}
                    />
                    Multipart asset upload
                  </label>
                  {multipart ? (
                    <div className={styles.twoColumns}>
                      <label>
                        Asset kind
                        <select value={assetKind} onChange={(e) => setAssetKind(e.target.value)}>
                          {['logo', 'image', 'font'].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        File
                        <input
                          key={fileKey}
                          type="file"
                          onChange={(e) => setFile(e.target.files?.[0])}
                        />
                      </label>
                    </div>
                  ) : (
                    <label>
                      JSON body
                      <textarea
                        rows={12}
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                  )}
                </>
              )}
            </fieldset>
            <div className={styles.row}>
              <button className={styles.primary} disabled={busy} onClick={() => void send()}>
                {busy ? 'Working…' : 'Send request'}
              </button>
              {busy && <button onClick={() => controller.current?.abort()}>Cancel request</button>}
              <button
                disabled={busy}
                onClick={() => {
                  setBody(exampleBody(endpoint));
                  setNotice('Example restored. Replace placeholders before sending.');
                }}
              >
                Reset body
              </button>
              <button disabled={busy} onClick={clearSensitive}>
                Clear inputs and results
              </button>
            </div>
          </section>
          <section className={styles.panel} aria-label="Response">
            <div className={styles.row}>
              <h2>Response</h2>
              {result && (
                <>
                  <strong className={result.status >= 400 ? styles.failed : styles.ok}>
                    HTTP {result.status} {result.statusText}
                  </strong>
                  <span>{result.elapsed} ms</span>
                </>
              )}
            </div>
            {!result ? (
              <p>
                Send a request to see its status, headers, and body. Nothing runs when you select an
                endpoint.
              </p>
            ) : (
              <>
                <div className={styles.row}>
                  <button onClick={() => setShowHeaders((v) => !v)}>
                    {showHeaders ? 'Hide headers' : 'Show headers'}
                  </button>
                  <button
                    onClick={() =>
                      void helper(async () => {
                        await navigator.clipboard.writeText(result.text);
                        setNotice('Response copied.');
                      })
                    }
                  >
                    Copy response
                  </button>
                  {canSign && (
                    <button disabled={busy} onClick={() => void helper(preparePasskey)}>
                      Use passkey and prepare verification
                    </button>
                  )}
                </div>
                {showHeaders && (
                  <pre>
                    {result.headers.map(([k, v]) => `${k}: ${v}`).join('\n') ||
                      'No readable response headers.'}
                  </pre>
                )}
                {result.truncated && <p>Response display limited to 1 MiB.</p>}
                <pre data-testid="console-response">
                  {result.data === undefined
                    ? result.text || '(empty body)'
                    : JSON.stringify(result.data, null, 2)}
                </pre>
              </>
            )}
          </section>
          {history.length > 0 && (
            <section className={styles.panel}>
              <h2>Recent requests</h2>
              <p>Metadata only, cleared on reload. Requests are never replayed automatically.</p>
              <ul className={styles.history}>
                {history.map((h, i) => (
                  <li key={i}>
                    <strong>{h.status}</strong>{' '}
                    <code>
                      {h.method} {h.path}
                    </code>{' '}
                    <span>{h.elapsed} ms</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
