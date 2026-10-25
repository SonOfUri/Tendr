// Small navigation helpers shared by the sign-in pages.

/** `next` if it is a same-site path (`/…`, not `//…`), else `fallback`. */
export function safeNext(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return fallback;
  }
  return next;
}

// A pending team invite survives the email-link round trip of signing up (the link opens in a new
// tab, so sessionStorage would lose it). It holds only the invite page path, which is single use
// and only works for the invited, verified email.
const PENDING_INVITE_KEY = 'tendr.pendingInvite';
const PENDING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function rememberPendingInvite(path: string): void {
  try {
    localStorage.setItem(PENDING_INVITE_KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // Storage unavailable: the person opens the invite link again after signing up.
  }
}

/** The pending invite path, cleared as it is read. */
export function takePendingInvite(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_INVITE_KEY);
    localStorage.removeItem(PENDING_INVITE_KEY);
    if (!raw) return null;
    const { path, at } = JSON.parse(raw) as { path?: string; at?: number };
    if (typeof path !== 'string' || !path.startsWith('/invite/')) return null;
    if (typeof at !== 'number' || Date.now() - at > PENDING_INVITE_TTL_MS) return null;
    return path;
  } catch {
    return null;
  }
}

/** The slug the API derives from a store name, before any `-2` collision suffix. */
export function previewSlug(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  s = s.slice(0, 28).replace(/-+$/, '');
  if (s.length === 0) return 'store';
  return s.length < 3 ? `${s}-store` : s;
}
