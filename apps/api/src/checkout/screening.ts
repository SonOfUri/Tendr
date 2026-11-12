import { usesTidepool } from '../lib/testnet.js';
// Sanctions screening of payer / refund addresses (Chainalysis public sanctions API).
//
// With SCREENING_MODE=chainalysis (the default), a lookup that cannot complete is fail closed:
// `unavailable`, never `allow`. `unavailable` is not persisted (the `screening_decision` enum is
// allow|block and a failed lookup is not a decision); it is logged, and the payment waits in
// SCREENING_PENDING for `retryPendingScreenings`.
// SCREENING_MODE=disabled explicitly skips live checks, recording skip events instead of
// provider decisions. The disabled policy neither reads nor writes the provider cache.
//
// Test mode (`ctx.livemode === false`) uses the SCREENING_TEST_BLOCKLIST fixture list and never
// makes an HTTP call. Results are cached in Redis per (chain, address), without the merchant, so
// one lookup serves every merchant: `block` for 24 h, `allow` for 1 h (a newly sanctioned address
// is caught within the hour). A dead Redis only costs the cache.
import type { ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { getSecret } from '../secrets/secrets.js';
import { holdPaymentInTx } from './hold.js';

export type ScreeningOutcome = 'allow' | 'block' | 'unavailable' | 'skipped';

/** An operator setting for live mode only; test fixtures keep exercising screening. */
export function screeningDisabled(livemode: boolean): boolean {
  return usesTidepool(livemode) || (livemode && env().SCREENING_MODE === 'disabled');
}

/** One durable disclosure per payment, including deposits whose sender cannot be resolved. */
export async function skipPaymentScreening(
  ctx: ScopeContext,
  paymentId: string,
): Promise<'skipped'> {
  await tenantTransaction(ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} AND merchant_id = ${ctx.merchantId} AND livemode = ${ctx.livemode} FOR UPDATE`;
    const existing = await tx.event.findFirst({
      where: {
        merchantId: ctx.merchantId,
        livemode: ctx.livemode,
        aggregateId: paymentId,
        type: 'payment.screening_skipped',
      },
      select: { id: true },
    });
    if (!existing)
      await recordEvent(tx, ctx, {
        aggregateType: 'payment',
        aggregateId: paymentId,
        type: 'payment.screening_skipped',
        payload: {
          decision: 'skipped',
          reason: usesTidepool(ctx.livemode) ? 'tidepool_testnet' : 'operator_disabled',
          screening_mode: 'disabled',
        },
      });
  });
  return 'skipped';
}

export const CHAINALYSIS_PURPOSE = 'chainalysis';
export const CHAINALYSIS_URL = 'https://public.chainalysis.com/api/v1/address/';
export const SCREENING_TIMEOUT_MS = 3000;
/** How long a `block` is cached: a sanctioned address stays blocked. */
export const SCREENING_CACHE_TTL_S = 24 * 3600;
/** How long an `allow` is cached (T6): a newly sanctioned address is caught within the hour. */
export const SCREENING_ALLOW_CACHE_TTL_S = 3600;
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
  // Preserve stored-secret rotation; deployments may instead configure a Railway secret variable.
  return row ? getSecret(row.id) : (env().CHAINALYSIS_API_KEY ?? null);
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
 * `screening_results`. `unavailable` (fail closed) has no row; `skipped` has an audit event only.
 */
export async function screenAddress(
  ctx: ScopeContext,
  input: { sessionId: string; address: string; chain: string },
): Promise<{ decision: ScreeningOutcome }> {
  const { sessionId, address, chain } = input;
  const decision = await addressDecision(ctx.livemode, address, chain);
  if (decision === 'unavailable') return { decision };
  if (decision === 'skipped') {
    await tenantTransaction(ctx, (tx) =>
      recordEvent(tx, ctx, {
        aggregateType: 'session',
        aggregateId: sessionId,
        type: 'session.screening_skipped',
        payload: {
          address,
          chain,
          decision,
          reason: 'operator_disabled',
          screening_mode: 'disabled',
        },
      }),
    );
    return { decision };
  }
  await prisma.screeningResult.create({
    data: {
      id: newId('scr'),
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      sessionId,
      address,
      chain,
      provider: ctx.livemode ? 'chainalysis' : 'test_fixture',
      // The sanctions API is a list match, not a score.
      riskScore: decision === 'block' ? 100 : 0,
      decision,
    },
  });
  return { decision };
}

/** Shared policy check; callers record the decision or skip in their own audit context. */
export async function addressDecision(
  livemode: boolean,
  address: string,
  chain: string,
): Promise<ScreeningOutcome> {
  // Do not read credentials, call the provider, or cache a fabricated approval.
  if (screeningDisabled(livemode)) return 'skipped';
  let decision: ScreeningOutcome;
  if (!livemode) {
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
          const ttl = decision === 'allow' ? SCREENING_ALLOW_CACHE_TTL_S : SCREENING_CACHE_TTL_S;
          await getRedis().set(key, decision, 'EX', ttl);
        } catch {
          // The cache is best effort.
        }
      }
    }
  }
  return decision;
}

/** Wallet payouts have no shopper session; audit them against the merchant account. */
export async function screenPayoutAddress(
  ctx: ScopeContext,
  address: string,
  chain: string,
): Promise<ScreeningOutcome> {
  const decision = await addressDecision(ctx.livemode, address, chain);
  await tenantTransaction(ctx, (tx) =>
    recordEvent(tx, ctx, {
      aggregateType: 'merchant_account',
      aggregateId: ctx.merchantId,
      type:
        decision === 'skipped'
          ? 'merchant_account.payout_screening_skipped'
          : 'merchant_account.payout_screened',
      payload: {
        address,
        chain,
        decision,
        ...(decision === 'skipped'
          ? {
              reason: usesTidepool(ctx.livemode) ? 'tidepool_testnet' : 'operator_disabled',
              screening_mode: 'disabled',
            }
          : {}),
      },
    }),
  );
  return decision;
}

// ─── retry job ───────────────────────────────────────────────────────────────

/** Called when a pending payment screens `allow`; Task 7's settlement path registers itself. */
export type ScreeningAllowedHook = (paymentId: string, ctx: ScopeContext) => Promise<void>;
let allowedHook: ScreeningAllowedHook | null = null;
export function onScreeningAllowed(hook: ScreeningAllowedHook | null): void {
  allowedHook = hook;
}

async function holdPayment(ctx: ScopeContext, paymentId: string) {
  await tenantTransaction(ctx, (tx) => holdPaymentInTx(tx, ctx, paymentId));
}

/** Flagged payments keep being re-screened hourly until this long after creation. */
export const SCREENING_STOP_MS = 7 * 24 * 3_600_000;
/** A claimed row is not picked up by another run for this long. */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Scheduled every minute: re-screens due SCREENING_PENDING payments. Backoff 1, 5, 15, 30 min,
 * then hourly. At 6 h from creation an unresolved payment is flagged (`screening_unresolved_at` +
 * `payment.screening_unresolved`, a merchant review item) and stays SCREENING_PENDING; hourly
 * retries continue until 7 days. `allow` hands the payment to the registered hook, `block` holds
 * payment and session. Each row is claimed with a lease before it is processed, so overlapping
 * runs never process a payment twice. Returns how many payments were processed.
 */
export async function retryPendingScreenings(now = new Date()): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: {
      status: 'SCREENING_PENDING',
      createdAt: { gt: new Date(now.getTime() - SCREENING_STOP_MS) },
      OR: [
        { screeningNextAt: { lte: now } },
        { screeningNextAt: null, createdAt: { lte: new Date(now.getTime() - FIRST_RETRY_MS) } },
      ],
    },
    orderBy: [{ screeningNextAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: 500,
  });
  let processed = 0;
  for (const p of pending) {
    const claim = await prisma.payment.updateMany({
      where: { id: p.id, status: 'SCREENING_PENDING', screeningNextAt: p.screeningNextAt },
      data: { screeningNextAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claim.count === 0) continue;
    processed++;
    const ctx = { merchantId: p.merchantId, livemode: p.livemode };
    const giveUpAt = p.createdAt.getTime() + SCREENING_GIVE_UP_MS;
    const backoff = async (flagged = Boolean(p.screeningUnresolvedAt)) => {
      const attempts = p.screeningAttempts + 1;
      let next = now.getTime() + (flagged ? HOURLY_MS : retryDelayMs(attempts));
      // The 6 h give-up fires at createdAt + 6 h, not on the next backoff tick after it.
      if (!flagged && now.getTime() < giveUpAt) next = Math.min(next, giveUpAt);
      await prisma.payment.update({
        where: { id: p.id },
        data: { screeningAttempts: attempts, screeningNextAt: new Date(next) },
      });
    };
    try {
      let decision: ScreeningOutcome = 'unavailable';
      // Every sender (a multi-input Bitcoin deposit has several): any block holds, any
      // unavailable keeps waiting, all allow settles.
      const senders =
        p.senderAddresses.length > 0 ? p.senderAddresses : p.senderAddress ? [p.senderAddress] : [];
      if (screeningDisabled(ctx.livemode)) {
        decision = await skipPaymentScreening(ctx, p.id);
      } else if (senders.length > 0 && p.senderChain) {
        const ds: ScreeningOutcome[] = [];
        for (const address of senders) {
          ds.push(
            (await screenAddress(ctx, { sessionId: p.sessionId, address, chain: p.senderChain }))
              .decision,
          );
        }
        decision = ds.includes('block')
          ? 'block'
          : ds.includes('unavailable')
            ? 'unavailable'
            : 'allow';
      } else {
        log('warn', 'screening retry: payment has no sender address', { paymentId: p.id });
      }
      if (decision === 'block') {
        await holdPayment(ctx, p.id);
      } else if (decision === 'allow' || decision === 'skipped') {
        let settled = false;
        if (allowedHook) {
          try {
            await allowedHook(p.id, ctx);
            const after = await prisma.payment.findUnique({
              where: { id: p.id },
              select: { status: true },
            });
            settled = after?.status !== 'SCREENING_PENDING';
          } catch (err) {
            log('error', 'screening allowed hook failed', { paymentId: p.id, err: String(err) });
          }
        } else {
          log('warn', 'screening allowed but no settlement hook registered', { paymentId: p.id });
        }
        if (!settled) await backoff();
      } else {
        if (!p.screeningUnresolvedAt && now.getTime() >= giveUpAt) {
          await tenantTransaction(ctx, async (tx) => {
            const { count } = await tx.payment.updateMany({
              where: {
                id: p.id,
                merchantId: ctx.merchantId,
                livemode: ctx.livemode,
                screeningUnresolvedAt: null,
              },
              data: { screeningUnresolvedAt: now },
            });
            if (count === 0) return;
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
        }
        await backoff(Boolean(p.screeningUnresolvedAt) || now.getTime() >= giveUpAt);
      }
    } catch (err) {
      log('error', 'screening retry failed', { paymentId: p.id, err: String(err) });
    }
  }
  return processed;
}
