// Integrator hooks, store side (project 5a, Task 11, spec §4, §5; rulings T11-a…T11-d).
//
// - Session create: `hook_data` sets `delivery = HOOK` (destination.ts says where it is allowed).
// - Trigger: `payment.succeeded` (the payment is SETTLED: the proceeds reached the contract) of a
//   HOOK session creates the payment's one hook call and makes its first attempt (deliver.ts).
// - `GET /v1/hook-calls` lists them; `POST /v1/payments/:id/hook/resend` retries a failed one
//   (refused while one is in flight, while retrying automatically, or after success).
// - `hook.failed` → ONE alert email to the store's notification email (or its owners).
import type { Prisma } from '@prisma/client';
import { type Event, type HookCall } from '@prisma/client';
import { z } from 'zod';
import type { ScopeContext, ScopedDb } from '../db/scoped.js';
import { scopedDb } from '../db/scoped.js';
import { dashboardPaymentUrl } from '../jobs/payment-notices.js';
import { handlerNamesFor, registerEventHandler } from '../jobs/handlers.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { oneLine, sendOncePerEvent, storeNoticeTarget } from '../merchants/store-notices.js';
import { attemptHook, enqueueHook, hookInFlight } from './deliver.js';

/** How long a hook call is retried automatically (the webhook window). */
export const HOOK_RETRY_WINDOW_MS = 3 * 24 * 3600_000;
export const HOOK_CREATE_HANDLER = 'hooks.create';
export const HOOK_FAILED_NOTICE_HANDLER = 'notify-hook-failed';

// ─── trigger ────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * `payment.succeeded` → the payment's hook call (once: one row per payment) and its first
 * attempt, when the session uses hook delivery and the payment is settled. Idempotent.
 */
export async function createHookCallForPayment(event: Event, now = new Date()): Promise<void> {
  if (!event.merchantId || event.livemode === null) return;
  const ctx = { merchantId: event.merchantId, livemode: event.livemode };
  const paymentId =
    str((event.payload as Record<string, unknown> | null)?.payment_id) || event.aggregateId;
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, ...ctx },
    select: {
      id: true,
      settledAt: true,
      session: {
        select: { id: true, delivery: true, hookData: true, destChain: true, recipient: true },
      },
    },
  });
  if (!payment || payment.session.delivery !== 'HOOK' || payment.settledAt === null) return;
  const s = payment.session;
  const id = newId('hook');
  const { count } = await prisma.hookCall.createMany({
    data: [
      {
        id,
        ...ctx,
        sessionId: s.id,
        paymentId: payment.id,
        chain: s.destChain,
        targetContract: s.recipient,
        hookData: (s.hookData ?? {}) as Prisma.InputJsonValue,
        retryUntil: new Date(now.getTime() + HOOK_RETRY_WINDOW_MS),
        nextRetryAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 1) await enqueueHook(id, now, now);
}

// ─── views and routes ───────────────────────────────────────────────────────

/** API status names: the stored `confirmed` reads `succeeded`. */
const STATUS_OUT: Record<string, string> = {
  pending: 'pending',
  submitted: 'submitted',
  confirmed: 'succeeded',
  failed: 'failed',
};
export const HookCallStatusValues = ['pending', 'submitted', 'succeeded', 'failed'] as const;
const STATUS_IN: Record<(typeof HookCallStatusValues)[number], string> = {
  pending: 'pending',
  submitted: 'submitted',
  succeeded: 'confirmed',
  failed: 'failed',
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function hookCallView(h: HookCall) {
  return {
    id: h.id,
    livemode: h.livemode,
    payment_id: h.paymentId,
    session_id: h.sessionId,
    chain: h.chain,
    contract: h.targetContract,
    hook_data: h.hookData,
    status: STATUS_OUT[h.status] ?? h.status,
    attempts: h.attempt,
    tx_hash: h.txHash,
    last_error: h.lastError,
    next_retry_at: iso(h.nextRetryAt),
    retry_until: h.retryUntil.toISOString(),
    succeeded_at: iso(h.succeededAt),
    created_at: h.createdAt.toISOString(),
    updated_at: h.updatedAt.toISOString(),
  };
}
export type HookCallView = ReturnType<typeof hookCallView>;

export const HookCallListQuerySchema = z
  .object({
    payment: z.string().min(1).max(64).optional(),
    session: z.string().min(1).max(64).optional(),
    status: z.enum(HookCallStatusValues).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    starting_after: z.string().min(1).max(64).optional(),
  })
  .strict();
export type HookCallListQuery = z.infer<typeof HookCallListQuerySchema>;

/** The mode's hook calls, newest first, cursor `starting_after`. */
export async function listHookCalls(db: ScopedDb, query: HookCallListQuery) {
  const where: Prisma.HookCallWhereInput = {};
  if (query.payment) where.paymentId = query.payment;
  if (query.session) where.sessionId = query.session;
  if (query.status) where.status = STATUS_IN[query.status] as HookCall['status'];
  const rows = await db.hookCall.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.starting_after ? { cursor: { id: query.starting_after }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  const more = rows.length > query.limit;
  return {
    hook_calls: page.map(hookCallView),
    has_more: more,
    next_cursor: more ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Retries a payment's failed hook call now (one attempt; a failure leaves it `failed` without
 * further retries, another event or email). NOT_FOUND for an unknown payment; CONFLICT when the
 * payment has no hook call, when an attempt is in flight, while it is still retrying by itself,
 * or after it succeeded.
 */
export async function resendHookCall(ctx: ScopeContext & { db: ScopedDb }, paymentId: string) {
  const now = new Date();
  const payment = await ctx.db.payment.findFirst({
    where: { id: paymentId },
    select: { id: true },
  });
  if (!payment) throw notFound('Payment not found');
  const hook = await ctx.db.hookCall.findFirst({ where: { paymentId } });
  if (!hook) throw conflict('This payment has no hook call', { payment_id: paymentId });
  const leased = hook.leaseUntil !== null && hook.leaseUntil > now;
  if (hookInFlight(hook, now) || leased) {
    throw conflict('A hook call for this payment is in flight', {
      status: STATUS_OUT[hook.status],
    });
  }
  if (hook.status !== 'failed') {
    throw conflict(
      hook.status === 'confirmed'
        ? 'The hook call already succeeded'
        : 'The hook call is still being retried automatically',
      { status: STATUS_OUT[hook.status] },
    );
  }
  const { count } = await prisma.hookCall.updateMany({
    where: {
      id: hook.id,
      merchantId: ctx.merchantId,
      livemode: ctx.livemode,
      status: 'failed',
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    data: { status: 'pending', nextRetryAt: now, retryUntil: now, leaseUntil: null },
  });
  if (count !== 1) throw conflict('A hook call for this payment is in flight');
  const after = await attemptHook(hook.id, { now, manual: true });
  return hookCallView(
    after ?? (await prisma.hookCall.findUniqueOrThrow({ where: { id: hook.id } })),
  );
}

// ─── alert ──────────────────────────────────────────────────────────────────

/** `hook.failed` → `hook_failed` to the store's notification email (or owners), once per event. */
export async function onHookFailedNotice(e: Event): Promise<void> {
  if (!e.merchantId || e.livemode === null) return;
  const hookCallId = str((e.payload as Record<string, unknown> | null)?.hook_call_id);
  const target = await storeNoticeTarget(e.merchantId);
  if (!target || target.recipients.length === 0) return;
  const db = scopedDb({ merchantId: e.merchantId, livemode: e.livemode });
  const h = await db.hookCall.findFirst({
    where: { id: hookCallId },
    include: { session: { select: { externalRef: true } } },
  });
  if (!h) {
    log('error', 'hook_failed skipped: hook call not found', { hookCallId });
    return;
  }
  const order = h.session.externalRef ? `order ${oneLine(h.session.externalRef)}` : 'an order';
  const subject = oneLine(
    `${e.livemode ? '' : '[Test] '}Your contract was not notified of the payment for ${order}`,
  );
  const dashboardUrl = dashboardPaymentUrl(h.paymentId, e.merchantId, e.livemode);
  const error = oneLine(h.lastError ?? 'unknown');
  const text = [
    `Tendr could not call onTendrDeposit on your contract ${h.targetContract} (${h.chain}) for ${order}.`,
    'The payment itself is settled: the funds are in your contract.',
    `We tried ${h.attempt} times over 3 days. Last error: ${error}`,
    '',
    `Once your contract accepts the call again, resend it: POST /v1/payments/${h.paymentId}/hook/resend`,
    `See the payment: ${dashboardUrl}`,
  ].join('\n');
  await sendOncePerEvent(e.id, 'hook_failed', target.recipients, {
    subject,
    text,
    data: {
      store_name: target.name,
      livemode: String(e.livemode),
      payment_id: h.paymentId,
      external_ref: h.session.externalRef ?? '',
      contract: h.targetContract,
      chain: h.chain,
      attempts: String(h.attempt),
      last_error: error,
      dashboard_url: dashboardUrl,
    },
  });
}

/** Registers the hook trigger and the failure alert (once). */
export function registerHookHandlers(): void {
  const handlers = [
    ['payment.succeeded', HOOK_CREATE_HANDLER, (e: Event) => createHookCallForPayment(e)],
    ['hook.failed', HOOK_FAILED_NOTICE_HANDLER, (e: Event) => onHookFailedNotice(e)],
  ] as const;
  for (const [type, name, fn] of handlers) {
    if (!handlerNamesFor(type).includes(name)) registerEventHandler(type, name, fn);
  }
}
