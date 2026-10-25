// The dashboard's API client: cookie session (credentials: include), the double-submit CSRF
// header on mutations, the selected store and mode headers, and typed errors from the API's
// `{ error: { code, message, requestId, details? } }` envelope.
import { CSRF_COOKIE } from '@tendr/contracts';
import { publicEnv } from './env';

export interface StoreContext {
  merchantId: string;
  livemode: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
  /** A JSON body (sets `Content-Type: application/json`). */
  json?: unknown;
  /** `false` for person routes (no store headers); an explicit store; default: the tab's store. */
  store?: false | StoreContext;
  /** Overrides the mode of the tab's store for this call. */
  livemode?: boolean;
}

// The selected store and mode are per tab (sessionStorage). They are UI preferences, not secrets.
const STORE_KEY = 'tendr.dashboard.store';

export function getStoreContext(): StoreContext | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoreContext>;
    if (typeof v.merchantId !== 'string' || !v.merchantId.startsWith('mer_')) return null;
    return { merchantId: v.merchantId, livemode: v.livemode === true };
  } catch {
    return null;
  }
}

export function setStoreContext(ctx: StoreContext | null): void {
  try {
    if (ctx) sessionStorage.setItem(STORE_KEY, JSON.stringify(ctx));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the choice lasts until reload.
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, store, livemode, headers: extra, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  if (json !== undefined) headers.set('Content-Type', 'application/json');

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set('Tendr-CSRF', csrf);
  }

  const ctx = store === false ? null : (store ?? getStoreContext());
  if (ctx) {
    headers.set('Tendr-Merchant', ctx.merchantId);
    headers.set('Tendr-Livemode', String(livemode ?? ctx.livemode));
  }

  let res: Response;
  try {
    res = await fetch(`${publicEnv.apiBaseUrl}${path}`, {
      ...rest,
      method,
      headers,
      credentials: 'include',
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'We could not reach Tendr. Check your connection.');
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const e = (
      body as { error?: { code?: string; message?: string; requestId?: string; details?: unknown } }
    )?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'HTTP_ERROR',
      e?.message ?? `Request failed (${res.status})`,
      e?.requestId,
      e?.details,
    );
  }
  return body as T;
}

/** True for a 401 that is not a step-up request: the session is missing or over. */
export const isSignedOut = (err: unknown) =>
  err instanceof ApiError && err.status === 401 && err.code !== 'STEP_UP_REQUIRED';

/** A message safe to show a merchant. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'NotAllowedError') {
    return 'The passkey prompt was closed or timed out. Try again.';
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Try again.';
}

// ─── API shapes used by the dashboard ───────────────────────────────────────

export type Role = 'owner' | 'admin' | 'finance' | 'viewer';

export interface StoreSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  membershipId: string;
  role: Role;
  isSigner: boolean;
}

export interface Passkey {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Me {
  user: { id: string; email: string; emailVerifiedAt: string | null };
  stores: StoreSummary[];
  passkeys: Passkey[];
}

export type AccountStatus = 'provisioning' | 'active' | 'failed' | string;

export interface AccountView {
  livemode: boolean;
  account: { id: string; nearAccountId: string; status: AccountStatus; threshold: number } | null;
  signers: { userId: string; email: string | null; keys: number }[];
}

export interface Balances {
  accountId: string | null;
  balances: { asset: string; amount: string }[];
}

export interface GoLiveStatus {
  checklist: {
    ok: boolean;
    missing: ('second_key' | 'threshold')[];
    signerCount: number;
    recoveryKeySet: boolean;
  };
  live: { status: AccountStatus; nearAccountId: string } | null;
}
