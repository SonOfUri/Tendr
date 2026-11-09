// Email magic links verify signup and sign returning people into their existing account on any
// device. Email sessions are NOT passkey-stepped-up: key changes and protected actions retain
// their separate checks. A login link cannot recover or replace a native wallet's signing key.
//
// A link carries 32 random bytes (base64url); only `sha256(token)` is stored in `email_tokens`.
// Links are single-use and live 15 minutes. Using a link creates the person on first use (one
// row per email even when several links race) and marks the email verified.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { getMailer } from './mailer.js';

export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/** A trimmed, lower-cased email address. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.string().email().max(254));

export function newLinkToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}

/**
 * Sends `login_link` to a verified person, including those with passkeys, and `verify_email` to
 * anyone new. The caller learns nothing about which case applied. `next` is a same-site path;
 * it travels in the email so opening the link in another tab/device preserves the destination.
 */
export async function startEmailSignIn(rawEmail: string, next?: string): Promise<void> {
  const email = EmailSchema.parse(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  const purpose = user?.emailVerifiedAt ? 'login' : 'verify';
  const { raw, hash } = newLinkToken();
  await prisma.emailToken.create({
    data: {
      id: newId('etok'),
      email,
      purpose,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    },
  });
  const url = new URL('/verify', env().WEB_URL);
  url.searchParams.set('token', raw);
  if (
    next?.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\') &&
    ![...next].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    url.searchParams.set('next', next);
  }
  await getMailer().send({
    to: email,
    template: purpose === 'login' ? 'login_link' : 'verify_email',
    data: { url: url.toString() },
  });
}

/**
 * Consumes a verify/login link and returns the person, creating them on first use. Throws 401
 * for an unknown, used or expired link. Registering a passkey does not change the email's person.
 */
export async function consumeEmailLink(token: string): Promise<{ userId: string; email: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized('Invalid or expired link');
  const now = new Date();
  // One statement, so concurrent uses of the same link have exactly one winner.
  const rows = await prisma.$queryRaw<{ email: string }[]>`
    UPDATE email_tokens SET consumed_at = ${now}
    WHERE token_hash = ${sha256(token)} AND consumed_at IS NULL AND expires_at > ${now}
      AND purpose IN ('verify', 'login')
    RETURNING email`;
  const email = rows[0]?.email;
  if (!email) throw unauthorized('Invalid or expired link');
  // Upsert on the unique email: racing first uses of different links create one person.
  const users = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO users (id, email, email_verified_at, created_at, updated_at)
    VALUES (${newId('per')}, ${email}, ${now}, ${now}, ${now})
    ON CONFLICT (email) DO UPDATE
      SET email_verified_at = COALESCE(users.email_verified_at, EXCLUDED.email_verified_at),
          updated_at = EXCLUDED.updated_at
    RETURNING id`;
  const userId = users[0]!.id;
  return { userId, email };
}
