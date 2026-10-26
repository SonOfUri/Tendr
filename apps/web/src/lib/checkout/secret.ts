// The session client secret arrives in the URL fragment (`/pay/<id>#cs=<secret>`), which browsers
// never send to a server. It is read, kept in memory and in sessionStorage under
// `tendr:cs:<sessionId>` (C27: a shopper who reloads while waiting keeps the page), and the
// fragment is stripped from the address bar with history.replaceState so it is not left in the
// URL, copied links or screenshots.
//
// - The fragment wins over a stored value; storage is read only when there is no fragment.
// - It is cleared (memory and storage) once the checkout reaches a terminal state.
// - Never localStorage, cookies or a URL; only ever sent as an Authorization header (api.ts).
// - Every storage access is wrapped: blocked storage (private mode, sandboxed frames) only loses
//   the reload convenience.

type SecretStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface FragmentEnv {
  location: { hash: string; pathname: string; search: string };
  history: {
    state: unknown;
    replaceState(data: unknown, unused: string, url?: string | null): void;
  };
  /** Reading it may throw when storage is blocked. */
  readonly sessionStorage?: SecretStorage;
}

const SECRET = /^(ses_[0-9A-HJKMNP-TV-Z]{26})_secret_[0-9a-f]{32}$/;

const secrets = new Map<string, string>();

/** The sessionStorage key for a session's secret. */
export const storageKey = (sessionId: string) => `tendr:cs:${sessionId}`;

const valid = (secret: string | null | undefined, sessionId: string): secret is string =>
  !!secret && SECRET.exec(secret)?.[1] === sessionId;

function withStorage<T>(env: FragmentEnv, fn: (s: SecretStorage) => T): T | null {
  try {
    const storage = env.sessionStorage;
    return storage ? fn(storage) : null;
  } catch {
    return null;
  }
}

/**
 * The client secret for `sessionId`: from `#cs=` (stored, then the fragment is stripped), else
 * from memory, else from sessionStorage. Null when none is valid for this session.
 */
export function takeClientSecret(sessionId: string, env: FragmentEnv): string | null {
  const hash = env.location.hash.startsWith('#') ? env.location.hash.slice(1) : env.location.hash;
  const fromFragment = hash ? new URLSearchParams(hash).get('cs') : null;
  if (fromFragment !== null) {
    env.history.replaceState(env.history.state, '', env.location.pathname + env.location.search);
    if (valid(fromFragment, sessionId)) {
      secrets.set(sessionId, fromFragment);
      withStorage(env, (s) => s.setItem(storageKey(sessionId), fromFragment));
      return fromFragment;
    }
  }
  const inMemory = secrets.get(sessionId);
  if (inMemory) return inMemory;
  const stored = withStorage(env, (s) => s.getItem(storageKey(sessionId)));
  if (valid(stored, sessionId)) {
    secrets.set(sessionId, stored);
    return stored;
  }
  return null;
}

/** Forgets the secret (memory and sessionStorage): the checkout reached a terminal state. */
export function clearClientSecret(
  sessionId: string,
  env: Pick<FragmentEnv, 'sessionStorage'>,
): void {
  secrets.delete(sessionId);
  withStorage(env as FragmentEnv, (s) => s.removeItem(storageKey(sessionId)));
}

/** Tests only: forget every secret held in memory. */
export function forgetClientSecrets(): void {
  secrets.clear();
}
