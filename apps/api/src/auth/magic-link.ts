// Email magic links: verifying a new person's email (signup) and bootstrapping their first
// passkey. A link creates a session ONLY for a person with no active passkey; anyone with a
// passkey signs in with it, so a mailbox alone never opens an account that has one.
// Losing every passkey is not solved by email: a signer recovers through the recovery kit
// (Task 12, `start_recovery`), which replaces the signer set on chain.
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

const hasActivePasskey = async (userId: string) =>
  (await prisma.webauthnCredential.count({ where: { userId, revokedAt: null } })) > 0;

/**
 * Sends a sign-in link: `login_link` to a verified person with no passkey yet, `verify_email` to
 * anyone new. A person with an active passkey gets nothing (they log in with the passkey). The
 * caller learns nothing about which case applied.
 */
export async function startEmailSignIn(rawEmail: string): Promise<void> {
  const email = EmailSchema.parse(rawEmail);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && (await hasActivePasskey(user.id))) return;
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
  await getMailer().send({
    to: email,
    template: purpose === 'login' ? 'login_link' : 'verify_email',
    data: { url: url.toString() },
  });
}

/**
 * Consumes a verify/login link and returns the person, creating them on first use. Throws 401
 * for an unknown, used or expired link, and for a person who has registered a passkey since the
 * link was sent.
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
  if (await hasActivePasskey(userId)) throw unauthorized('Sign in with your passkey');
  return { userId, email };
}
