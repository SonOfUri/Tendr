// Sanctions screening of payer / refund addresses (Chainalysis public sanctions API).
//
// Fail closed: a lookup that cannot complete (timeout, HTTP error, no API key in live mode) is
// `unavailable`, never `allow`. `unavailable` is not persisted (the `screening_decision` enum is
// allow|block and a failed lookup is not a decision); it is logged, and the payment waits in
// SCREENING_PENDING for `retryPendingScreenings`.
//
// Test mode (`ctx.livemode === false`) uses the SCREENING_TEST_BLOCKLIST fixture list and never
// makes an HTTP call. Results are cached 24 h in Redis per (chain, address), without the
// merchant, so one lookup serves every merchant. A dead Redis only costs the cache.
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { transitionPayment, transitionSession } from '../events/transitions.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { getSecret } from '../secrets/secrets.js';

export type ScreeningOutcome = 'allow' | 'block' | 'unavailable';

export const CHAINALYSIS_PURPOSE = 'chainalysis';
export const CHAINALYSIS_URL = 'https://public.chainalysis.com/api/v1/address/';
export const SCREENING_TIMEOUT_MS = 3000;
export const SCREENING_CACHE_TTL_S = 24 * 3600;
/** After this long unresolved, a pending payment becomes a review item (not a hold). */
export const SCREENING_GIVE_UP_MS = 6 * 3_600_000;
/** First retry 1 min after the payment appeared; then 5, 15, 30 min; then hourly. */
export const FIRST_RETRY_MS = 60_000;
const LATER_RETRY_MS = [5, 15, 30].map((m) => m * 60_000);
const HOURLY_MS = 3_600_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const realFetch: FetchLike = (url, init) => fetch(url, init);
let fetchImpl: FetchLike = realFetch;
/** Test hook: replaces the HTTP client; null restores the real one. */
export function setScreeningFetch(f: FetchLike | null): void {
  fetchImpl = f ?? realFetch;
}

const cacheKey = (chain: string, address: string) =>
  `screening:${chain.toLowerCase()}:${address.startsWith('0x') ? address.toLowerCase() : address}`;

/** Delay until the next retry once `attemptsDone` retries have failed (0 = none yet). */
export function retryDelayMs(attemptsDone: number): number {
  if (attemptsDone <= 0) return FIRST_RETRY_MS;
  return LATER_RETRY_MS[attemptsDone - 1] ?? HOURLY_MS;
}

async function chainalysisKey(): Promise<string | null> {
  const row = await prisma.secret.findFirst({
    where: { purpose: CHAINALYSIS_PURPOSE },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return row ? getSecret(row.id) : null;
}

async function lookupLive(address: string): Promise<ScreeningOutcome> {
  let key: string | null;
  try {
    key = await chainalysisKey();
  } catch (err) {
    log('warn', 'screening: could not read the chainalysis secret', { err: String(err) });
    return 'unavailable';
  }
  if (!key) {
    log('warn', 'screening unavailable: no chainalysis API key configured');
    return 'unavailable';
  }
  try {
    const res = await fetchImpl(`${CHAINALYSIS_URL}${encodeURIComponent(address)}`, {
      headers: { 'X-API-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(SCREENING_TIMEOUT_MS),
    });
    if (!res.ok) {
      log('warn', 'screening unavailable: provider error', { status: res.status });
      return 'unavailable';
    }
    const body = (await res.json()) as { identifications?: unknown };
    if (!Array.isArray(body.identifications)) {
      log('warn', 'screening unavailable: unexpected provider response');
      return 'unavailable';
    }
    return body.identifications.length > 0 ? 'block' : 'allow';
  } catch (err) {
    log('warn', 'screening unavailable: lookup failed', { err: String(err) });
    return 'unavailable';
  }
}

function lookupTest(address: string): ScreeningOutcome {
  const blocked = env()
    .SCREENING_TEST_BLOCKLIST.split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return blocked.includes(address.toLowerCase()) ? 'block' : 'allow';
}

/**
 * Screens one address for the session and records the `allow` / `block` decision in
 * `screening_results`. `unavailable` (fail closed) is returned without a row.
 */
export async function screenAddress(
  ctx: ScopeContext,
  input: { sessionId: string; address: string; chain: string },
): Promise<{ decision: ScreeningOutcome }> {
  const { sessionId, address, chain } = input;
  let decision: ScreeningOutcome;
  if (!ctx.livemode) {
    decision = lookupTest(address);
  } else {
    const key = cacheKey(chain, address);
    let cached: string | null = null;
    try {
      cached = await getRedis().get(key);
    } catch {
      // Redis down: look up without the cache.
    }
    if (cached === 'allow' || cached === 'block') {
      decision = cached;
    } else {
      decision = await lookupLive(address);
      if (decision !== 'unavailable') {
        try {
          await getRedis().set(key, decision, 'EX', SCREENING_CACHE_TTL_S);
        } catch {
          // The cache is best effort.
        }
      }
    }
  }
  if (decision === 'unavailable') return { decision };
  await prisma.screeningResult.create({
    data: {
      id: newId('scr'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      sessionId,
      address,
      chain,
      provider: 'chainalysis',
      // The sanctions API is a list match, not a score.
      riskScore: decision === 'block' ? 100 : 0,
      decision,
    },
  });
  return { decision };
}

// ─── retry job ───────────────────────────────────────────────────────────────

/** Called when a pending payment screens `allow`; Task 7's settlement path registers itself. */
export type ScreeningAllowedHook = (paymentId: string, ctx: ScopeContext) => Promise<void>;
let allowedHook: ScreeningAllowedHook | null = null;
export function onScreeningAllowed(hook: ScreeningAllowedHook | null): void {
  allowedHook = hook;
}

async function holdPayment(ctx: ScopeContext, paymentId: string, sessionId: string) {
  await tenantTransaction(ctx, async (tx) => {
    await transitionPayment(tx, ctx, paymentId, 'HELD', { reason: 'sanctions' });
    await tx.payment.updateMany({
      where: { id: paymentId, merchantId: ctx.merchantId, livemode: ctx.livemode },
      data: { heldReason: 'sanctions' },
    });
    await transitionSession(tx, ctx, sessionId, 'HELD', { reason: 'sanctions' });
    await recordEvent(tx, ctx, {
      aggregateType: 'payment',
      aggregateId: paymentId,
      type: 'payment.held',
      payload: { payment_id: paymentId, session_id: sessionId, held_reason: 'sanctions' },
    });
  });
}

/**
 * Scheduled every minute: re-screens due SCREENING_PENDING payments. Backoff 1, 5, 15, 30 min,
 * then hourly, for up to 6 h from the payment's creation. `allow` hands the payment to the
 * registered hook, `block` holds payment and session, and past 6 h the payment is flagged
 * (`screening_unresolved_at` + `payment.screening_unresolved`) and stays SCREENING_PENDING.
 * Returns how many payments were processed.
 */
export async function retryPendingScreenings(now = new Date()): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: { status: 'SCREENING_PENDING', screeningUnresolvedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  let processed = 0;
  for (const p of pending) {
    const dueAt = p.screeningNextAt ?? new Date(p.createdAt.getTime() + FIRST_RETRY_MS);
    if (dueAt > now) continue;
    processed++;
    const ctx = { merchantId: p.merchantId, livemode: p.livemode };
    try {
      if (!p.senderAddress || !p.senderChain) {
        log('warn', 'screening retry: payment has no sender address', { paymentId: p.id });
        continue;
      }
      const { decision } = await screenAddress(ctx, {
        sessionId: p.sessionId,
        address: p.senderAddress,
        chain: p.senderChain,
      });
      if (decision === 'block') {
        await holdPayment(ctx, p.id, p.sessionId);
      } else if (decision === 'allow') {
        if (allowedHook) await allowedHook(p.id, ctx);
        else
          log('warn', 'screening allowed but no settlement hook registered', { paymentId: p.id });
      } else if (now.getTime() - p.createdAt.getTime() >= SCREENING_GIVE_UP_MS) {
        await tenantTransaction(ctx, async (tx) => {
          await tx.payment.updateMany({
            where: { id: p.id, merchantId: ctx.merchantId, livemode: ctx.livemode },
            data: { screeningUnresolvedAt: now, screeningAttempts: { increment: 1 } },
          });
          await recordEvent(tx, ctx, {
            aggregateType: 'payment',
            aggregateId: p.id,
            type: 'payment.screening_unresolved',
            payload: {
              payment_id: p.id,
              session_id: p.sessionId,
              attempts: p.screeningAttempts + 1,
            },
          });
        });
      } else {
        const attempts = p.screeningAttempts + 1;
        await prisma.payment.update({
          where: { id: p.id },
          data: {
            screeningAttempts: attempts,
            screeningNextAt: new Date(now.getTime() + retryDelayMs(attempts)),
          },
        });
      }
    } catch (err) {
      log('error', 'screening retry failed', { paymentId: p.id, err: String(err) });
    }
  }
  return processed;
}
