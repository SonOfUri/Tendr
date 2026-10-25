// Dashboard sessions: a person signed in to the dashboard.
//
// The session token is 32 random bytes (base64url) held in the HttpOnly `tendr_session` cookie;
// only `sha256(token)` is stored. Sessions slide: each use (at most once a minute) pushes
// `expires_at` to now + DASHBOARD_SESSION_TTL_MS.
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

export async function createDashboardSession(userId: string): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + DASHBOARD_SESSION_TTL_MS);
  const row = await prisma.dashboardSession.create({
    data: { id: newId('dss'), userId, tokenHash: sha256(token), expiresAt, lastUsedAt: new Date() },
  });
  return { sessionId: row.id, token, csrf: csrfFor(token), expiresAt };
}

export type ResolvedSession = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  /** True when this use slid the expiry, so the cookies should be re-issued. */
  slid: boolean;
};

/** The live session for a raw token, or null (unknown, revoked or expired). */
export async function resolveDashboardSession(token: string): Promise<ResolvedSession | null> {
  if (!TOKEN.test(token)) return null;
  const now = new Date();
  const row = await prisma.dashboardSession.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.revokedAt || row.expiresAt <= now) return null;
  if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < SLIDE_INTERVAL_MS) {
    return { sessionId: row.id, userId: row.userId, expiresAt: row.expiresAt, slid: false };
  }
  const expiresAt = new Date(now.getTime() + DASHBOARD_SESSION_TTL_MS);
  // Conditional, so a session revoked meanwhile is not revived.
  const { count } = await prisma.dashboardSession.updateMany({
    where: { id: row.id, revokedAt: null, expiresAt: { gt: now } },
    data: { expiresAt, lastUsedAt: now },
  });
  if (count === 0) return null;
  return { sessionId: row.id, userId: row.userId, expiresAt, slid: true };
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
