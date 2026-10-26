import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { closeRedis, getRedis, whenReady } from '../lib/redis.js';
import { putSecret } from '../secrets/secrets.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  onScreeningAllowed,
  retryDelayMs,
  retryPendingScreenings,
  screenAddress,
  setScreeningFetch,
} from './screening.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function liveSetup() {
  const m = await createMerchant();
  const session = await createRow('Session', m.id, true, {});
  await putSecret('test-key', 'chainalysis');
  return { ctx: { merchantId: m.id, livemode: true }, sessionId: session.id as string };
}

beforeEach(async () => {
  await resetDb();
  await whenReady(getRedis());
  const keys = await getRedis().keys('screening:*');
  if (keys.length) await getRedis().del(...keys);
  setScreeningFetch(null);
  onScreeningAllowed(null);
});
afterAll(async () => {
  setScreeningFetch(null);
  await closeRedis();
});

describe('screenAddress (live)', () => {
  it('allows when identifications is empty, sends the key, and records a result', async () => {
    const { ctx, sessionId } = await liveSetup();
    const fetchMock = vi.fn(async () => json({ identifications: [] }));
    setScreeningFetch(fetchMock);
    await expect(screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' })).resolves.toEqual({
      decision: 'allow',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://public.chainalysis.com/api/v1/address/${ADDR}`);
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
    const rows = await prisma.screeningResult.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'chainalysis', decision: 'allow', address: ADDR });
  });

  it('blocks on a non-empty identifications list', async () => {
    const { ctx, sessionId } = await liveSetup();
    setScreeningFetch(async () => json({ identifications: [{ category: 'sanctions' }] }));
    await expect(screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' })).resolves.toEqual({
      decision: 'block',
    });
    expect((await prisma.screeningResult.findFirst({ where: { sessionId } }))?.decision).toBe(
      'block',
    );
  });

  it('is unavailable on timeout, HTTP error or garbage, and stores nothing', async () => {
    const { ctx, sessionId } = await liveSetup();
    for (const f of [
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      async () => json({}, 503),
      async () => json({ nope: true }),
    ]) {
      setScreeningFetch(f);
      await expect(screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' })).resolves.toEqual(
        { decision: 'unavailable' },
      );
    }
    expect(await prisma.screeningResult.count()).toBe(0);
  });

  it('is unavailable (never allow) without a configured secret', async () => {
    const m = await createMerchant();
    const session = await createRow('Session', m.id, true, {});
    const fetchMock = vi.fn(async () => json({ identifications: [] }));
    setScreeningFetch(fetchMock);
    const ctx = { merchantId: m.id, livemode: true };
    await expect(
      screenAddress(ctx, { sessionId: session.id as string, address: ADDR, chain: 'eth' }),
    ).resolves.toEqual({ decision: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a second lookup from the cache, across merchants', async () => {
    const { ctx, sessionId } = await liveSetup();
    const fetchMock = vi.fn(async () => json({ identifications: [] }));
    setScreeningFetch(fetchMock);
    await screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' });
    const m2 = await createMerchant();
    const s2 = await createRow('Session', m2.id, true, {});
    const second = await screenAddress(
      { merchantId: m2.id, livemode: true },
      { sessionId: s2.id as string, address: ADDR.toUpperCase().replace('0X', '0x'), chain: 'eth' },
    );
    expect(second.decision).toBe('allow');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await prisma.screeningResult.count()).toBe(2);
  });

  it('T6: caches allow for at most 1 h and block for 24 h', async () => {
    const { ctx, sessionId } = await liveSetup();
    setScreeningFetch(async () => json({ identifications: [] }));
    await screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' });
    const allowTtl = await getRedis().ttl(`screening:eth:${ADDR.toLowerCase()}`);
    expect(allowTtl).toBeGreaterThan(0);
    expect(allowTtl).toBeLessThanOrEqual(3600);
    const BAD = '0x2222222222222222222222222222222222222222';
    setScreeningFetch(async () => json({ identifications: [{ category: 'sanctions' }] }));
    await screenAddress(ctx, { sessionId, address: BAD, chain: 'eth' });
    const blockTtl = await getRedis().ttl(`screening:eth:${BAD}`);
    expect(blockTtl).toBeGreaterThan(23 * 3600);
    expect(blockTtl).toBeLessThanOrEqual(24 * 3600);
  });

  it('does not cache unavailable', async () => {
    const { ctx, sessionId } = await liveSetup();
    const fetchMock = vi.fn(async () => json({}, 500));
    setScreeningFetch(fetchMock);
    await screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' });
    await screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('screenAddress (test mode)', () => {
  it('uses the fixture blocklist and makes no HTTP call', async () => {
    const m = await createMerchant();
    const session = await createRow('Session', m.id, false, {});
    const fetchMock = vi.fn();
    setScreeningFetch(fetchMock);
    const ctx = { merchantId: m.id, livemode: false };
    const sessionId = session.id as string;
    await expect(
      screenAddress(ctx, {
        sessionId,
        address: '0x000000000000000000000000000000000000dEaD',
        chain: 'eth',
      }),
    ).resolves.toEqual({ decision: 'block' });
    await expect(screenAddress(ctx, { sessionId, address: ADDR, chain: 'eth' })).resolves.toEqual({
      decision: 'allow',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('retryDelayMs', () => {
  it('is 1, 5, 15, 30 min, then hourly', () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => retryDelayMs(n) / 60_000)).toEqual([1, 5, 15, 30, 60, 60]);
  });
});

describe('retryPendingScreenings', () => {
  async function pending(livemode: boolean, address: string, ageMs = 0) {
    const m = await createMerchant();
    const p = await createRow('Payment', m.id, livemode, {
      status: 'SCREENING_PENDING',
      senderAddress: address,
      senderChain: 'eth',
    });
    await prisma.session.update({
      where: { id: p.sessionId as string },
      data: { status: 'SCREENING_PENDING' },
    });
    await prisma.payment.update({
      where: { id: p.id },
      data: { createdAt: new Date(Date.now() - ageMs) },
    });
    return { id: p.id as string, sessionId: p.sessionId as string, merchantId: m.id };
  }
  const reload = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
  const events = (id: string) =>
    prisma.event.findMany({ where: { aggregateId: id }, orderBy: { createdAt: 'asc' } });

  it('backs off while unavailable, then hands an allow to the hook', async () => {
    await putSecret('k', 'chainalysis');
    const p = await pending(true, ADDR, 2 * 60_000);
    const hook = vi.fn(async () => {});
    onScreeningAllowed(hook);
    setScreeningFetch(async () => json({}, 503));
    const t0 = new Date();
    expect(await retryPendingScreenings(t0)).toBe(1);
    const after1 = await reload(p.id);
    expect(after1.screeningAttempts).toBe(1);
    expect(after1.screeningNextAt!.getTime() - t0.getTime()).toBe(5 * 60_000);
    expect(after1.status).toBe('SCREENING_PENDING');
    // Not due yet.
    expect(await retryPendingScreenings(new Date(t0.getTime() + 60_000))).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    // Provider recovers.
    setScreeningFetch(async () => json({ identifications: [] }));
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    expect(await retryPendingScreenings(t1)).toBe(1);
    expect(hook).toHaveBeenCalledWith(p.id, { merchantId: p.merchantId, livemode: true });
    expect((await reload(p.id)).status).toBe('SCREENING_PENDING');
  });

  it('holds payment and session on block with a payment.held event', async () => {
    const p = await pending(false, '0x000000000000000000000000000000000000dead', 5 * 60_000);
    expect(await retryPendingScreenings()).toBe(1);
    const pay = await reload(p.id);
    expect(pay.status).toBe('HELD');
    expect(pay.heldReason).toBe('sanctions');
    expect((await prisma.session.findUniqueOrThrow({ where: { id: p.sessionId } })).status).toBe(
      'HELD',
    );
    expect((await events(p.id)).map((e) => e.type)).toContain('payment.held');
  });

  it('after 6 h creates one review item, keeps the payment pending, and keeps retrying hourly', async () => {
    await putSecret('k', 'chainalysis');
    const p = await pending(true, ADDR, 6 * 3_600_000 + 1000);
    setScreeningFetch(async () => json({}, 503));
    const t = new Date();
    expect(await retryPendingScreenings(t)).toBe(1);
    const pay = await reload(p.id);
    expect(pay.status).toBe('SCREENING_PENDING');
    expect(pay.screeningUnresolvedAt).not.toBeNull();
    expect(pay.screeningNextAt!.getTime() - t.getTime()).toBe(3_600_000);
    expect((await events(p.id)).map((e) => e.type)).toEqual(['payment.screening_unresolved']);
    // Hourly re-screen: an allow now reaches the hook; no second review item.
    const hook = vi.fn(async () => {});
    onScreeningAllowed(hook);
    setScreeningFetch(async () => json({ identifications: [] }));
    expect(await retryPendingScreenings(new Date(t.getTime() + 3_600_000))).toBe(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await events(p.id)).toHaveLength(1);
  });

  it('stops retrying 7 days after creation', async () => {
    await pending(true, ADDR, 7 * 24 * 3_600_000 + 1000);
    expect(await retryPendingScreenings()).toBe(0);
  });

  it('clamps the backoff so the give-up fires at createdAt + 6 h', async () => {
    await putSecret('k', 'chainalysis');
    const p = await pending(true, ADDR, 5.5 * 3_600_000);
    await prisma.payment.update({ where: { id: p.id }, data: { screeningAttempts: 9 } });
    setScreeningFetch(async () => json({}, 503));
    const t = new Date();
    await retryPendingScreenings(t);
    const pay = await reload(p.id);
    const created = pay.createdAt.getTime();
    expect(pay.screeningNextAt!.getTime()).toBe(created + 6 * 3_600_000);
  });

  it('treats a payment without a sender address as unavailable', async () => {
    const p = await pending(false, ADDR, 6 * 3_600_000 + 1000);
    await prisma.payment.update({ where: { id: p.id }, data: { senderAddress: null } });
    expect(await retryPendingScreenings()).toBe(1);
    const pay = await reload(p.id);
    expect(pay.screeningUnresolvedAt).not.toBeNull();
    expect(pay.screeningNextAt).not.toBeNull();
  });

  it('overlapping runs process a payment once', async () => {
    await putSecret('k', 'chainalysis');
    const old = await pending(true, ADDR, 6 * 3_600_000 + 1000);
    const ok = await pending(false, ADDR, 5 * 60_000);
    setScreeningFetch(async () => json({}, 503));
    const hook = vi.fn(async () => {});
    onScreeningAllowed(hook);
    const t = new Date();
    await Promise.all([retryPendingScreenings(t), retryPendingScreenings(t)]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(ok.id, expect.anything());
    expect(
      (await events(old.id)).filter((e) => e.type === 'payment.screening_unresolved'),
    ).toHaveLength(1);
    expect((await reload(old.id)).screeningAttempts).toBe(1);
  });

  it('backs off after an allow whose hook fails or does not transition', async () => {
    const p = await pending(false, ADDR, 5 * 60_000);
    const t = new Date();
    onScreeningAllowed(async () => {
      throw new Error('boom');
    });
    await retryPendingScreenings(t);
    let pay = await reload(p.id);
    expect(pay.screeningAttempts).toBe(1);
    expect(pay.screeningNextAt!.getTime() - t.getTime()).toBe(5 * 60_000);
    // A hook that returns without transitioning also backs off (attempt 2 -> 15 min).
    onScreeningAllowed(async () => {});
    const t2 = new Date(t.getTime() + 5 * 60_000);
    expect(await retryPendingScreenings(t2)).toBe(1);
    pay = await reload(p.id);
    expect(pay.screeningNextAt!.getTime() - t2.getTime()).toBe(15 * 60_000);
    expect(await retryPendingScreenings(new Date(t2.getTime() + 60_000))).toBe(0);
  });

  it('skips payments that are not due yet', async () => {
    const p = await pending(false, ADDR, 0);
    expect(await retryPendingScreenings()).toBe(0);
    expect((await reload(p.id)).screeningAttempts).toBe(0);
  });
});
