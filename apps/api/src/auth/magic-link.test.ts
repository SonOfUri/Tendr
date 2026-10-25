import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createCredential, createUser, resetDb } from '../test/helpers.js';
import { memoryMailer, tokenFromMail } from '../test/dashboard.js';
import { consumeEmailLink, MAGIC_LINK_TTL_MS, startEmailSignIn } from './magic-link.js';

describe('magic links', () => {
  beforeEach(async () => {
    await resetDb();
    memoryMailer().clear();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a new email gets a verify link to WEB_URL/verify; only the hash is stored', async () => {
    await startEmailSignIn('  Ada@Example.COM ');
    const [mail] = memoryMailer().sent;
    expect(mail).toMatchObject({ to: 'ada@example.com', template: 'verify_email' });
    expect(mail!.data.url).toMatch(/^http:\/\/localhost:3000\/verify\?token=[A-Za-z0-9_-]{43}$/);
    const token = tokenFromMail('ada@example.com', 'verify_email');
    const row = await prisma.emailToken.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(token);
    expect(row.purpose).toBe('verify');
    // No person exists until the link is used.
    expect(await prisma.user.count()).toBe(0);
  });

  it('a verified person gets a login link instead', async () => {
    await createUser({ email: 'grace@example.com', emailVerifiedAt: new Date() });
    await startEmailSignIn('grace@example.com');
    expect(memoryMailer().sent[0]).toMatchObject({ template: 'login_link' });
  });

  it('a person with an active passkey gets no email link at all (passkey login only)', async () => {
    const user = await createUser({ email: 'pk@example.com', emailVerifiedAt: new Date() });
    await createCredential(user.id);
    await startEmailSignIn('pk@example.com');
    expect(memoryMailer().sent).toEqual([]);
    expect(await prisma.emailToken.count()).toBe(0);
    // A revoked passkey does not count: the person can bootstrap a new first passkey by email.
    // (Losing every passkey of a signer is handled by the recovery kit, Task 12.)
    await prisma.webauthnCredential.updateMany({ data: { revokedAt: new Date() } });
    await startEmailSignIn('pk@example.com');
    expect(memoryMailer().sent).toHaveLength(1);
  });

  it('a link issued before the person registered a passkey no longer signs in', async () => {
    await startEmailSignIn('ada@example.com');
    const token = tokenFromMail('ada@example.com', 'verify_email');
    await startEmailSignIn('ada@example.com');
    const second = tokenFromMail('ada@example.com', 'verify_email');
    const { userId } = await consumeEmailLink(token);
    await createCredential(userId);
    await expect(consumeEmailLink(second)).rejects.toMatchObject({ status: 401 });
  });

  it('magic_link_single_use_and_expires_15min', async () => {
    expect(MAGIC_LINK_TTL_MS).toBe(15 * 60_000);
    await startEmailSignIn('ada@example.com');
    const token = tokenFromMail('ada@example.com', 'verify_email');
    const row = await prisma.emailToken.findFirstOrThrow();
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(
      MAGIC_LINK_TTL_MS - 1000,
    );
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(
      MAGIC_LINK_TTL_MS + 1000,
    );

    const first = await consumeEmailLink(token);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: first.userId } });
    expect(user).toMatchObject({ email: 'ada@example.com', emailVerifiedAt: expect.any(Date) });
    await expect(consumeEmailLink(token)).rejects.toMatchObject({ status: 401 });

    await startEmailSignIn('ada@example.com');
    const late = tokenFromMail('ada@example.com', 'login_link');
    await prisma.emailToken.updateMany({
      where: { consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(consumeEmailLink(late)).rejects.toMatchObject({ status: 401 });
    await expect(consumeEmailLink('garbage')).rejects.toMatchObject({ status: 401 });
  });

  it('concurrent_signup_same_email_creates_one_person', async () => {
    await Promise.all(Array.from({ length: 4 }, () => startEmailSignIn('ada@example.com')));
    const tokens = memoryMailer().sent.map((m) => new URL(m.data.url!).searchParams.get('token')!);
    expect(tokens).toHaveLength(4);
    const results = await Promise.all(tokens.map((t) => consumeEmailLink(t)));
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});
