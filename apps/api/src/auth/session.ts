// Dashboard sessions: a person signed in to the dashboard.
//
// The session token is 32 random bytes (base64url) held in the HttpOnly `tendr_session` cookie;
// only `sha256(token)` is stored. Sessions slide: each use (at most once a minute) pushes
// `expires_at` to now + DASHBOARD_SESSION_TTL_MS, but never past created_at + 90 days.
//
// Step-up: `passkey_verified_at` records when the session last proved a passkey (passkey login,
// registering the person's first passkey, or `POST /v1/auth/passkeys/step-up/verify`). Sensitive
// actions require it within STEP_UP_WINDOW_MS.
//
// CSRF: cookie-authenticated mutations must send `Tendr-CSRF` equal to the readable `tendr_csrf`
// cookie (double submit). The CSRF value is derived from the session token, so a value planted
// by another origin (or taken from another session) never matches.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CSRF_COOKIE, DASHBOARD_SESSION_TTL_MS, SESSION_COOKIE } from '@tendr/contracts';
import { env } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';

const SLIDE_INTERVAL_MS = 60_000;
/** A session ends this long after creation, however often it is used. */
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** How recent a passkey assertion must be for sensitive actions. */
export const STEP_UP_WINDOW_MS = 10 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The CSRF value for a session token: base64url(sha256("tendr-csrf-v1:" + token)). */
export function csrfFor(token: string): string {
  return createHash('sha256').update(`tendr-csrf-v1:${token}`).digest('base64url');
}

export function csrfMatches(token: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(csrfFor(token));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type NewSession = { sessionId: string; token: string; csrf: string; expiresAt: Date };

/** `passkeyVerified`: the session starts from a passkey assertion (passkey login). */
export async function createDashboardSession(
  userId: string,
  opts: { passkeyVerified?: boolean } = {},
): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DASHBOARD_SESSION_TTL_MS);
  const row = await prisma.dashboardSession.create({
    data: {
      id: newId('dss'),
      userId,
      tokenHash: sha256(token),
      expiresAt,
      lastUsedAt: now,
      createdAt: now,
      passkeyVerifiedAt: opts.passkeyVerified ? now : null,
    },
  });
  return { sessionId: row.id, token, csrf: csrfFor(token), expiresAt };
}

export type ResolvedSession = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  passkeyVerifiedAt: Date | null;
  /** True when this use slid the expiry, so the cookies should be re-issued. */
  slid: boolean;
};

/** The live session for a raw token, or null (unknown, revoked or expired). */
export async function resolveDashboardSession(token: string): Promise<ResolvedSession | null> {
  if (!TOKEN.test(token)) return null;
  const now = new Date();
  const row = await prisma.dashboardSession.findUnique({ where: { tokenHash: sha256(token) } });
  const hardEnd = row ? row.createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS : 0;
  if (!row || row.revokedAt || row.expiresAt <= now || hardEnd <= now.getTime()) return null;
  const base = {
    sessionId: row.id,
    userId: row.userId,
    passkeyVerifiedAt: row.passkeyVerifiedAt,
  };
  if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < SLIDE_INTERVAL_MS) {
    return { ...base, expiresAt: row.expiresAt, slid: false };
  }
  const expiresAt = new Date(Math.min(now.getTime() + DASHBOARD_SESSION_TTL_MS, hardEnd));
  // Conditional, so a session revoked meanwhile is not revived.
  const { count } = await prisma.dashboardSession.updateMany({
    where: { id: row.id, revokedAt: null, expiresAt: { gt: now } },
    data: { expiresAt, lastUsedAt: now },
  });
  if (count === 0) return null;
  return { ...base, expiresAt, slid: true };
}

/** Records a fresh passkey assertion on the session (step-up). */
export async function markPasskeyVerified(sessionId: string): Promise<void> {
  await prisma.dashboardSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { passkeyVerifiedAt: new Date() },
  });
}

/** Whether a session's last passkey assertion is within the step-up window. */
export function isSteppedUp(passkeyVerifiedAt: Date | null, now = Date.now()): boolean {
  return passkeyVerifiedAt !== null && now - passkeyVerifiedAt.getTime() <= STEP_UP_WINDOW_MS;
}

export async function revokeDashboardSession(sessionId: string): Promise<void> {
  await prisma.dashboardSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Parses a `Cookie` header. Later duplicates do not override the first value. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

function secure(): boolean {
  const mode = env().NODE_ENV;
  return mode !== 'development' && mode !== 'test';
}

function cookie(name: string, value: string, maxAgeSeconds: number, httpOnly: boolean): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(secure() ? ['Secure'] : []),
  ].join('; ');
}

/** `Set-Cookie` values for a session: the HttpOnly token and the readable CSRF value. */
export function sessionCookies(token: string, expiresAt: Date): string[] {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    cookie(SESSION_COOKIE, token, maxAge, true),
    cookie(CSRF_COOKIE, csrfFor(token), maxAge, false),
  ];
}

export function clearedSessionCookies(): string[] {
  return [cookie(SESSION_COOKIE, '', 0, true), cookie(CSRF_COOKIE, '', 0, false)];
}
