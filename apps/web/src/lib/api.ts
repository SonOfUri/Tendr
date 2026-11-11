// The dashboard's API client: cookie session (credentials: include), the double-submit CSRF
// header on mutations, the selected store and mode headers, and typed errors from the API's
// `{ error: { code, message, requestId, details? } }` envelope.
//
// CSRF (R31): the API returns the session's CSRF value as `csrfToken` in every response that
// starts or describes a session (email verify, passkey login/register, step-up, recovery session,
// `GET /v1/me`). It is kept in memory only (module state, gone on reload until `/v1/me` answers
// again) and sent as `Tendr-CSRF`; the readable `tendr_csrf` cookie is the fallback, which works
// only when the dashboard and the API share a host.
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

let csrfToken: string | null = null;

/** Sets (or, with null, forgets) the in-memory CSRF value. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** The value `Tendr-CSRF` carries: the in-memory token, else the cookie. */
export function currentCsrf(): string | null {
  return csrfToken ?? readCookie(CSRF_COOKIE);
}

type SignedOutHandler = () => void;
let signedOutHandler: SignedOutHandler | null = null;

/**
 * Registers what happens when any request finds the session missing or over (401
 * `UNAUTHENTICATED`): the dashboard sends the person to sign in. Returns a function that
 * unregisters it.
 */
export function onSignedOut(handler: SignedOutHandler): () => void {
  signedOutHandler = handler;
  return () => {
    if (signedOutHandler === handler) signedOutHandler = null;
  };
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, store, livemode, headers: extra, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(extra);
  headers.set('Accept', 'application/json');
  if (json !== undefined) headers.set('Content-Type', 'application/json');

  if (!SAFE_METHODS.has(method)) {
    const csrf = currentCsrf();
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
    const err = new ApiError(
      res.status,
      e?.code ?? 'HTTP_ERROR',
      e?.message ?? `Request failed (${res.status})`,
      e?.requestId,
      e?.details,
    );
    if (isSignedOut(err)) {
      csrfToken = null;
      signedOutHandler?.();
    }
    throw err;
  }
  const returned = (body as { csrfToken?: unknown } | undefined)?.csrfToken;
  if (typeof returned === 'string' && returned.length > 0) csrfToken = returned;
  return body as T;
}

/**
 * True only when the session is missing or over (`UNAUTHENTICATED`). A failed passkey ceremony
 * (`UNAUTHORIZED`, e.g. a step-up with someone else's passkey) or a step-up request
 * (`STEP_UP_REQUIRED`) is not a sign-out.
 */
export const isSignedOut = (err: unknown) =>
  err instanceof ApiError && err.status === 401 && err.code === 'UNAUTHENTICATED';

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
  account: {
    id: string;
    kind?: 'contract' | 'native_intents';
    capabilities?: {
      multisig: boolean;
      timedRecovery: boolean;
      contractLimits: boolean;
      autoSweep: boolean;
      nativePasskeyPayouts: boolean;
      nativeWalletKeyManagement?: boolean;
    };
    nearAccountId: string;
    status: AccountStatus;
    threshold: number;
    /** Decimal u64: bumps on every signer-set change. */
    signerEpoch: string;
    /**
     * Set while the account's NEAR for contract storage is low and Tendr's automatic top-up is
     * blocked; new proposals may start failing until it is funded.
     */
    storageLowAt?: string | null;
  } | null;
  signers: { userId: string; email: string | null; keys: number }[];
  /** The mode's Tendr release code hash (base58), if configured; upgrades are compared to it. */
  releaseCodeHash?: string | null;
  nativeWallet?: { ownerUserId: string; credentialId: string; publicKey: string } | null;
}

export interface Balances {
  accountId: string | null;
  balances: { asset: string; amount: string }[];
}

export interface GoLiveStatus {
  accountKind?: 'native_intents';
  registrationPath?: string;
  checklist: {
    ok: boolean;
    /** `live_mode_unavailable` (listed first) while the platform's live-mode switch is off. */
    missing: ('live_mode_unavailable' | 'second_key' | 'threshold' | 'wallet_passkey')[];
    signerCount: number;
    recoveryKeySet: boolean;
  };
  live: { status: AccountStatus; nearAccountId: string } | null;
}

export type ProposalStatus =
  | 'draft'
  | 'pending'
  | 'timelocked'
  | 'executing'
  | 'executed'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** The contract's `Action` as JSON: one key (the kind) holding its fields. */
export type ActionJson = Record<string, unknown>;

export interface Proposal {
  id: string;
  kind: string;
  status: ProposalStatus;
  onchainId: string;
  action: ActionJson;
  createdByUserId: string | null;
  readyAt: string | null;
  executedAt: string | null;
  lastTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  approvals: { userId: string; signerEpoch: string; txHash: string | null; approvedAt: string }[];
}

export interface SavedAddress {
  id: string;
  chain: string;
  address: string;
  status: 'pending' | 'active' | 'revoked';
  activeFrom: string;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  role: Role;
  isSigner: boolean;
  createdAt: string;
}

export interface Team {
  members: TeamMember[];
  invites: { id: string; email: string; role: Role; expiresAt: string; createdAt: string }[];
}

export type SignerKey = { p256: string } | { ed25519: string };

export interface MemberKeys {
  membershipId: string;
  userId: string;
  role: Role;
  isSigner: boolean;
  keys: SignerKey[];
}

export interface AssetLimit {
  asset: string;
  perTx: string | null;
  perDay: string | null;
  refundCap: string | null;
  autoSweep: {
    triggerAbove: string | null;
    keep: string | null;
    savedAddressId: string | null;
    chain: string | null;
    address: string | null;
  } | null;
}

export interface RecoveryRequest {
  id: string;
  onchainId: string | null;
  status: 'pending' | 'cancelled' | 'executed' | 'failed';
  executesAt: string;
  newSignerIds: string[];
  newThreshold: number | null;
  createdAt: string;
}

export interface RecoveryParams {
  accountId: string;
  livemode: boolean;
  recoveryKeySet: boolean;
  recoveryKeyEpoch: string;
  lastNonce: string;
}

/** The WebAuthn request for approving or cancelling (from a `/challenge` route). */
export interface SignerChallenge {
  challengeB64u: string;
  allowCredentials: { id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }[];
}
