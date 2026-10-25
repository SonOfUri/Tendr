import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createUser, resetDb } from '../test/helpers.js';
import {
  createDashboardSession,
  markPasskeyVerified,
  resolveDashboardSession,
  SESSION_ABSOLUTE_TTL_MS,
  STEP_UP_WINDOW_MS,
} from './session.js';

const DAY = 24 * 60 * 60 * 1000;

describe('dashboard sessions', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('expire 90 days after creation however often they are used', async () => {
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(90 * DAY);
    const user = await createUser();
    const s = await createDashboardSession(user.id);
    // Sliding never pushes expiry past created_at + 90 days.
    await prisma.dashboardSession.update({
      where: { id: s.sessionId },
      data: { createdAt: new Date(Date.now() - 89 * DAY), lastUsedAt: null },
    });
    const slid = await resolveDashboardSession(s.token);
    expect(slid).not.toBeNull();
    expect(slid!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY + 1000);

    await prisma.dashboardSession.update({
      where: { id: s.sessionId },
      data: {
        createdAt: new Date(Date.now() - 90 * DAY - 1000),
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    expect(await resolveDashboardSession(s.token)).toBeNull();
  });

  it('records when the session last proved a passkey', async () => {
    expect(STEP_UP_WINDOW_MS).toBe(10 * 60_000);
    const user = await createUser();
    const email = await createDashboardSession(user.id);
    expect((await resolveDashboardSession(email.token))!.passkeyVerifiedAt).toBeNull();
    await markPasskeyVerified(email.sessionId);
    expect((await resolveDashboardSession(email.token))!.passkeyVerifiedAt).toBeInstanceOf(Date);
    const passkey = await createDashboardSession(user.id, { passkeyVerified: true });
    expect((await resolveDashboardSession(passkey.token))!.passkeyVerifiedAt).toBeInstanceOf(Date);
  });
});
