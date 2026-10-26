// The session client secret arrives in the URL fragment (`/pay/<id>#cs=<secret>`), which browsers
// never send to a server. It is read once, kept in memory only (this module's map: gone on
// reload), and the fragment is stripped from the address bar with history.replaceState so it is
// not left in the URL, copied links or screenshots. It is never written to localStorage,
// sessionStorage or cookies, and only ever sent as an Authorization header (see api.ts).

export interface FragmentEnv {
  location: { hash: string; pathname: string; search: string };
  history: {
    state: unknown;
    replaceState(data: unknown, unused: string, url?: string | null): void;
  };
}

const SECRET = /^(ses_[0-9A-HJKMNP-TV-Z]{26})_secret_[0-9a-f]{32}$/;

const secrets = new Map<string, string>();

/**
 * The client secret for `sessionId`: from `#cs=` on first call (stripping the fragment), then from
 * memory. Null when missing, malformed or for another session.
 */
export function takeClientSecret(sessionId: string, env: FragmentEnv): string | null {
  const hash = env.location.hash.startsWith('#') ? env.location.hash.slice(1) : env.location.hash;
  const fromFragment = hash ? new URLSearchParams(hash).get('cs') : null;
  if (fromFragment !== null) {
    env.history.replaceState(env.history.state, '', env.location.pathname + env.location.search);
    const m = SECRET.exec(fromFragment);
    if (m && m[1] === sessionId) secrets.set(sessionId, fromFragment);
  }
  return secrets.get(sessionId) ?? null;
}

/** Tests only: forget every secret held in memory. */
export function forgetClientSecrets(): void {
  secrets.clear();
}
