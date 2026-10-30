// Signed merchant webhooks (checkout spec §8): endpoints, Stripe-style signatures, delivery with
// retries for 3 days, resend.
//
// Flow: a checkout event commits with its outbox row → the dispatcher runs the fan-out handler
// (registered only for the merchant-facing types) → one `webhook_deliveries` row per subscribed
// endpoint of the event's mode → a `deliver-webhook` job sends it. A send POSTs
// `{ id, type, created, livemode, data }` with `Tendr-Signature: t=<unix>,v1=<hex>` and a 10 s
// timeout; a 2xx is delivered; anything else is retried 1 min × 2^n later until 3 days after the
// first attempt, then `failed`. A manual resend is always allowed and keeps the same event id.
//
// Ruling C23: internal ops events (payment.verification_blocked, payment.verification_timeout,
// refund.needs_review, payment.screening_unresolved, session.created, …) are never delivered: only
// the types in `WebhookEventTypeValues` (plus `ping`, sent only by the test-send route) are.
// Ruling C24: in live mode endpoint URLs must be https and must not resolve to private, loopback or
// link-local addresses — checked at create and again at send time (on the connection's own DNS
// lookup, so a rebinding answer cannot slip through); redirects are never followed.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Event, Prisma, WebhookDelivery, WebhookEndpoint } from '@prisma/client';
import {
  WEBHOOK_RETRY_WINDOW_MS,
  WebhookEventTypeValues,
  type WebhookEventType,
} from '@tendr/contracts';
import type { Queue } from 'bullmq';
import { scopedDb, type ScopeContext } from '../db/scoped.js';
import { tenantTransaction } from '../db/tenant-transaction.js';
import { computeSignature } from '../gateway/signing.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { LOCAL_DEV_HOSTS } from '../lib/local-hosts.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { registerEventHandler, handlerNamesFor } from '../jobs/handlers.js';
import { getSecret, putSecret } from '../secrets/secrets.js';

export const SIGNATURE_HEADER = 'Tendr-Signature';
/** The test-send event type; never fanned out, only sent to the one endpoint being tested. */
export const PING_EVENT = 'ping';
export const FANOUT_HANDLER = 'webhooks.fanout';
/** BullMQ job (on the webhooks queue) that sends one delivery. */
export const DELIVER_WEBHOOK_JOB = 'deliver-webhook';
/** Re-queues pending deliveries whose retry is due (a lost delayed job never strands one). */
export const SWEEP_WEBHOOKS_JOB = 'sweep-webhooks';
export const SEND_TIMEOUT_MS = 10_000;
/** First retry delay; the n-th failed attempt waits `RETRY_BASE_MS × 2^(n-1)`. */
export const RETRY_BASE_MS = 60_000;
/** While a send is in flight its `next_retry_at` is pushed this far out (the claim lease). */
export const SEND_LEASE_MS = 30_000;
export const WEBHOOK_SECRET_PURPOSE = 'webhook_signing';
const MAX_ERROR_LEN = 500;
const MAX_URL_LEN = 2048;
const DELIVERY_STATUS = {
  pending: 'pending',
  delivered: 'delivered',
  failed: 'failed',
  /** W9: a re-connect found the new endpoint already had this event; never sent. */
  superseded: 'superseded',
} as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

// ─── what is delivered ──────────────────────────────────────────────────────

const DELIVERABLE: ReadonlySet<string> = new Set<string>(WebhookEventTypeValues);

/** Whether `type` is a merchant-facing webhook event (ruling C23 allowlist; `ping` excluded). */
export function isDeliverableEventType(type: string): type is WebhookEventType {
  return DELIVERABLE.has(type);
}

/**
 * Event payload keys a merchant may see. Anything else (sender addresses and screening details,
 * proposal ids, internal verification method, notification routing) never leaves Tendr.
 */
const DATA_KEYS = [
  'session_id',
  'external_ref',
  /** The payment link the session was opened from, and the payer's note from its page. */
  'payment_link_id',
  'payer_note',
  'payment_id',
  'refund_id',
  /** A merchant refund's own reference (the WooCommerce refund id), W7. */
  'refund_external_ref',
  'quote_id',
  'endpoint_id',
  'reason',
  'session_status',
  'deposit_address',
  'origin_asset',
  'amount_received',
  'origin_tx_hash',
  'amount_in',
  'amount_out',
  'settlement_asset',
  'settle_tx',
  'overpaid_amount',
  'kept_small_overpayment',
  'refunded_amount',
  'refund_via',
  'refund_reason',
  'held_reason',
  'notice',
  'asset',
  'amount',
  'return_fee',
  'destination',
  'destination_chain',
  'tx_hash',
  'customer_email_on_file',
] as const;

/** Keys a merchant may see only on the named event types (on top of DATA_KEYS). */
const GAS_BUDGET_KEYS = [
  'mode',
  'month',
  'budget_usd',
  'reserved_usd',
  'spent_usd',
  'remaining_usd',
] as const;
const HOOK_KEYS = ['hook_call_id', 'chain', 'contract', 'attempts'] as const;
const TYPE_DATA_KEYS: Readonly<Partial<Record<string, readonly string[]>>> = {
  /** Who paid the network fee and how (`NetworkFeeView`; null for older quotes). */
  'payment.succeeded': ['network_fee'],
  'refund.cancelled': ['status'],
  'refund.failed': ['status'],
  'gas.budget_low': GAS_BUDGET_KEYS,
  'gas.budget_exhausted': [...GAS_BUDGET_KEYS, 'requested_usd'],
  /** Integrator hooks: the call, the contract it notified and how many attempts it took. */
  'hook.succeeded': HOOK_KEYS,
  /** …and the last error (the contract's revert reason). */
  'hook.failed': [...HOOK_KEYS, 'error'],
};

/**
 * The webhook `data` for an event payload: only the allowlisted keys (DATA_KEYS, plus the event
 * type's own TYPE_DATA_KEYS), `external_ref`, `payment_link_id` and `payer_note` always set.
 */
export function webhookData(payload: unknown, type?: string): Record<string, unknown> {
  const src = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = [...DATA_KEYS, ...((type && TYPE_DATA_KEYS[type]) || [])];
  for (const k of keys) if (k in src) out[k] = src[k];
  if ('session_id' in out) {
    for (const k of ['external_ref', 'payment_link_id', 'payer_note'])
      if (!(k in out)) out[k] = null;
  }
  return out;
}

/** The exact request body for an event; identical on every attempt and resend. */
export function webhookBody(
  event: Pick<Event, 'id' | 'type' | 'createdAt' | 'payload' | 'livemode'>,
): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created: Math.floor(event.createdAt.getTime() / 1000),
    livemode: event.livemode === true,
    data: webhookData(event.payload, event.type),
  });
}

/**
 * The `Tendr-Signature` value: `t=<t>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`. During a
 * rotation overlap `previousSecrets` (the old secret) add further `v1=` values, Stripe-style, so a
 * receiver still verifying with the old secret keeps accepting until it switches.
 */
export function signPayload(
  secret: string,
  t: number,
  rawBody: string | Buffer,
  previousSecrets: readonly string[] = [],
): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return [secret, ...previousSecrets].reduce(
    (h, s) => `${h},v1=${computeSignature(s, t, body)}`,
    `t=${t}`,
  );
}

/** After a rotation the old secret also signs (a second `v1=`) for this long. */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

/** The current secret first, then the previous one while its rotation overlap lasts. */
async function signingSecrets(
  e: Pick<WebhookEndpoint, 'secretRef' | 'previousSecretRef' | 'previousSecretExpiresAt'>,
  now: Date,
): Promise<string[]> {
  const out = [await getSecret(e.secretRef)];
  if (e.previousSecretRef && e.previousSecretExpiresAt && e.previousSecretExpiresAt > now) {
    out.push(await getSecret(e.previousSecretRef));
  }
  return out;
}

/** Delay after the `attempt`-th failed send (1-based): 1 min, 2 min, 4 min, … */
export function retryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt - 1, 30));
}

// ─── URL policy and SSRF guard ──────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible (deprecated; embeds any IPv4) — T9
  ['64:ff9b::', 96], // NAT64: may front any IPv4, including private ones
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo: tunnels to an arbitrary IPv4 — T9
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: embeds an arbitrary IPv4
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Whether an IP literal is private, loopback, link-local or otherwise not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family !== 6) return true; // not an IP: never treated as safe
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d, ::ffff:7f00:1): judge the embedded IPv4. IPv4-compatible
  // (::a.b.c.d) is in ::/96 and blocked outright.
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1]!;
    if (isIP(tail) === 4) return blocked.check(tail, 'ipv4');
    const parts = tail.split(':');
    if (parts.length === 2) {
      const n = (parseInt(parts[0]!, 16) << 16) | parseInt(parts[1]!, 16);
      const v4 = [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
      return blocked.check(v4, 'ipv4');
    }
    return true;
  }
  return blocked.check(ip, 'ipv6');
}

type Resolver = (host: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) =>
      err ? reject(err) : resolve(addrs),
    ),
  );
let resolver: Resolver = systemResolver;

/** Test hook: replaces the DNS resolver (null restores the system one). Tests never use the network. */
export function setWebhookResolver(fn: Resolver | null): void {
  resolver = fn ?? systemResolver;
}

/**
 * Whether endpoints of this mode get the full SSRF policy (https only, public addresses only).
 * Always in live mode; in test mode too when running in production — test mode is relaxed (http
 * and private hosts allowed for local development) only when NODE_ENV is development or test.
 */
export function strictHostPolicy(livemode: boolean): boolean {
  return livemode || process.env.NODE_ENV === 'production';
}

const invalidUrl = (message: string) => new AppError('VALIDATION_ERROR', message, 400);

/**
 * Checks an endpoint URL for `livemode` and returns its normalised form. Strict (live, or any
 * mode in production — `strictHostPolicy`): `https://` only, and the host (literal or every DNS
 * answer) must be a public address. Relaxed (test mode outside production): `https://` anywhere,
 * or `http://localhost` (also 127.0.0.1 / [::1]) for local development.
 */
export async function validateEndpointUrl(raw: string, livemode: boolean): Promise<string> {
  if (raw.length > MAX_URL_LEN) throw invalidUrl('The URL is too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidUrl('The URL is not valid');
  }
  if (url.username || url.password) throw invalidUrl('The URL must not contain credentials');
  url.hash = '';
  const strict = strictHostPolicy(livemode);
  if (url.protocol === 'http:') {
    if (strict) throw invalidUrl('Webhook endpoints must use https://');
    if (!LOCAL_DEV_HOSTS.has(url.hostname)) {
      throw invalidUrl('http:// is allowed only for localhost in test mode; use https://');
    }
  } else if (url.protocol !== 'https:') {
    throw invalidUrl('The URL must use https://');
  }
  if (strict) await assertPublicHost(url.hostname);
  return url.toString();
}

const ssrfError = () =>
  invalidUrl('Webhook endpoints must resolve to public addresses (not private or loopback)');

/** Throws unless `hostname` is a public IP literal or resolves only to public addresses. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw ssrfError();
    return;
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(host);
  } catch {
    throw invalidUrl('The URL host could not be resolved');
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw ssrfError();
}

/**
 * A `lookup` for the outbound socket that refuses private answers, so the address actually
 * connected to is the one checked (no DNS-rebinding gap between check and connect).
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  resolver(hostname).then(
    (addrs) => {
      const family = typeof options === 'object' ? options.family : undefined;
      const usable = addrs.filter((a) => !family || a.family === family);
      if (usable.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
        const err = Object.assign(new Error('webhook host resolves to a private address'), {
          code: 'EBLOCKED',
        });
        return callback(err, '', 4);
      }
      if (typeof options === 'object' && options.all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
      }
      callback(null, usable[0]!.address, usable[0]!.family);
    },
    (err: NodeJS.ErrnoException) => callback(err, '', 4),
  );
};

// ─── transport ──────────────────────────────────────────────────────────────

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  livemode: boolean;
  /** Apply the SSRF guard to the connection (`strictHostPolicy`). */
  strict: boolean;
}
/** Resolves with the HTTP status; rejects on a network error or timeout. */
export type WebhookTransport = (req: WebhookRequest) => Promise<{ status: number }>;

/** POSTs with a 10 s overall timeout, never following redirects (a 3xx is just a non-2xx). */
const httpTransport: WebhookTransport = async (req) => {
  const url = new URL(req.url);
  if (req.strict) {
    if (url.protocol !== 'https:') throw new Error('webhooks must use https');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) throw new Error('webhook host is a private address');
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const opts: RequestOptions = {
    method: 'POST',
    headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
    ...(req.strict ? { lookup: guardedLookup } : {}),
  };
  return new Promise((resolve, reject) => {
    const r = send(url, opts, (res) => {
      res.resume(); // discard the body
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', reject);
    });
    const timer = setTimeout(
      () => r.destroy(new Error(`timed out after ${SEND_TIMEOUT_MS}ms`)),
      SEND_TIMEOUT_MS,
    );
    r.on('close', () => clearTimeout(timer));
    r.on('error', reject);
    r.end(req.body);
  });
};

let transport: WebhookTransport = httpTransport;

/** Test hook: replaces the HTTP transport (null restores the real one). */
export function setWebhookTransport(fn: WebhookTransport | null): void {
  transport = fn ?? httpTransport;
}

let beforeSend: ((deliveryId: string) => Promise<void>) | null = null;

/**
 * Test hook: runs after a send's claim, before it reads the endpoint (null removes it). Lets a
 * test land a re-connect between a worker's claim and its POST.
 */
export function setBeforeSendHook(fn: ((deliveryId: string) => Promise<void>) | null): void {
  beforeSend = fn;
}

let beforeFanOutWrite: (() => Promise<void>) | null = null;

/**
 * Test hook: runs in `fanOutEvent` after it chose the endpoints and before it writes the rows
 * (null removes it). Lets a test land a re-connect between the two.
 */
export function setBeforeFanOutWriteHook(fn: (() => Promise<void>) | null): void {
  beforeFanOutWrite = fn;
}

// ─── scheduling ─────────────────────────────────────────────────────────────

export interface DeliverJobData {
  deliveryId: string;
}
let queue: Pick<Queue, 'add'> | null = null;

/** The worker's webhooks queue; without one (API process, tests) the sweeper picks rows up. */
export function setWebhookQueue(q: Pick<Queue, 'add'> | null): void {
  queue = q;
}

async function enqueue(deliveryId: string, at: Date, now: Date): Promise<void> {
  if (!queue) return;
  await queue.add(DELIVER_WEBHOOK_JOB, { deliveryId } satisfies DeliverJobData, {
    jobId: `whd__${deliveryId}__${at.getTime()}`,
    delay: Math.max(0, at.getTime() - now.getTime()),
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: { age: 86_400 },
  });
}

// ─── fan-out ────────────────────────────────────────────────────────────────

const subscribed = (e: Pick<WebhookEndpoint, 'events'>, type: string) =>
  e.events.length === 0 || e.events.includes('*') || e.events.includes(type);

/** The delivery idempotency key: one row per (endpoint, event). */
export const deliveryKey = (endpointId: string, eventId: string) => `whd_${endpointId}_${eventId}`;

const SESSION_CONNECTION = { connectionId: true } as const;

/** How many re-connects `liveConnectionId` follows before giving up (ruling W8). */
export const MAX_REPLACEMENT_HOPS = 10;

/**
 * The live connection that now speaks for `connectionId` (ruling W8): itself while not revoked;
 * after a site re-connect, the connection that replaced it (`replaced_by_id`), followed to the
 * live end of the chain. Null when the chain ends in a connection revoked with no successor (a
 * disconnect, a dashboard removal, a sweep), runs past MAX_REPLACEMENT_HOPS, or loops.
 */
export async function liveConnectionId(
  connectionId: string,
  merchantId: string,
): Promise<string | null> {
  const seen = new Set<string>();
  let id: string | null = connectionId;
  for (let hop = 0; id !== null && hop <= MAX_REPLACEMENT_HOPS; hop++) {
    if (seen.has(id)) return null;
    seen.add(id);
    const c: { revokedAt: Date | null; replacedById: string | null } | null =
      await prisma.connection.findFirst({
        where: { id, merchantId },
        select: { revokedAt: true, replacedById: true },
      });
    if (!c) return null;
    if (c.revokedAt === null) return id;
    id = c.replacedById;
  }
  return null;
}

/**
 * Whether a key bound to `keyConnectionId` may act on (read, expire, refund) a session created by
 * `sessionConnectionId`: a hand-made key (no connection) acts on any session of its store; a
 * connection key only on its own connection's sessions or those of a connection it replaced (the
 * `replaced_by_id` chain, followed by `liveConnectionId`). Callers answer "no" as NOT_FOUND.
 */
export async function connectionMayAct(
  keyConnectionId: string | null | undefined,
  merchantId: string,
  sessionConnectionId: string | null,
): Promise<boolean> {
  if (!keyConnectionId) return true;
  if (sessionConnectionId === null) return false;
  if (sessionConnectionId === keyConnectionId) return true;
  return (await liveConnectionId(sessionConnectionId, merchantId)) === keyConnectionId;
}

/**
 * The live connection for the event's session, resolved from the event's subject (its
 * aggregate), never from its payload: a session; a payment → its session; a refund → its payment
 * → its session. The session's connection is then followed through re-connects
 * (`liveConnectionId`). Null when the session was made with a dashboard key, its connection was
 * disconnected or removed, or the subject is none of these — such an event goes only to endpoints
 * bound to no connection.
 */
export async function eventConnectionId(
  event: Pick<Event, 'aggregateType' | 'aggregateId'>,
  ctx: ScopeContext,
): Promise<string | null> {
  const created = await sessionConnectionId(event, ctx);
  return created === null ? null : liveConnectionId(created, ctx.merchantId);
}

/** The connection whose key created the event's session (as recorded; possibly revoked). */
async function sessionConnectionId(
  event: Pick<Event, 'aggregateType' | 'aggregateId'>,
  ctx: ScopeContext,
): Promise<string | null> {
  const id = event.aggregateId;
  switch (event.aggregateType) {
    case 'session': {
      const s = await prisma.session.findFirst({
        where: { id, ...ctx },
        select: SESSION_CONNECTION,
      });
      return s?.connectionId ?? null;
    }
    case 'payment': {
      const p = await prisma.payment.findFirst({
        where: { id, ...ctx },
        select: { session: { select: SESSION_CONNECTION } },
      });
      return p?.session.connectionId ?? null;
    }
    case 'refund': {
      const r = await prisma.refund.findFirst({
        where: { id, ...ctx },
        select: { payment: { select: { session: { select: SESSION_CONNECTION } } } },
      });
      return r?.payment.session.connectionId ?? null;
    }
    default:
      return null;
  }
}

/**
 * Whether an endpoint may receive an event of connection `eventConnection` (spec §2.6): an
 * endpoint Connect made for one site receives only that connection's events; a hand-made endpoint
 * (no connection) receives every event of its store and mode.
 */
const forConnection = (
  e: Pick<WebhookEndpoint, 'connectionId'>,
  eventConnection: string | null,
): boolean => e.connectionId === null || e.connectionId === eventConnection;

/**
 * The outbox handler: creates one delivery per active endpoint of the event's merchant AND mode
 * that subscribes to its type and may see its connection (`forConnection`), and queues the first
 * send. Idempotent on (endpoint, event). Returns how many deliveries the event has.
 */
export async function fanOutEvent(event: Event, now = new Date()): Promise<number> {
  if (!isDeliverableEventType(event.type)) return 0; // C23: internal events never leave
  if (!event.merchantId || event.livemode === null) return 0;
  const ctx = { merchantId: event.merchantId, livemode: event.livemode };
  const sessionId = await sessionOf(ctx, event.payload);
  // C9: the rows are written holding a share lock on the chosen endpoints, and only while all of
  // them are still active. A re-connect deactivates the old endpoints (a row lock) before it
  // re-points their deliveries, so a fan-out either commits first (its rows get re-pointed) or
  // sees the endpoint gone and chooses again (its rows go to the new endpoint): never stranded.
  for (let round = 0; round < 3; round++) {
    let endpoints = (
      await prisma.webhookEndpoint.findMany({
        where: { ...ctx, active: true },
        select: { id: true, events: true, connectionId: true },
      })
    ).filter((e) => subscribed(e, event.type));
    if (endpoints.some((e) => e.connectionId !== null)) {
      const connection = await eventConnectionId(event, ctx);
      endpoints = endpoints.filter((e) => forConnection(e, connection));
    }
    if (endpoints.length === 0) return 0;
    if (beforeFanOutWrite) await beforeFanOutWrite();
    const ids = endpoints.map((e) => e.id);
    const written = await prisma.$transaction(async (tx) => {
      const live = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM webhook_endpoints WHERE id = ANY(${ids}) AND active ORDER BY id FOR SHARE`;
      if (live.length !== ids.length) return false; // one went away meanwhile: choose again
      await tx.webhookDelivery.createMany({
        data: endpoints.map((e) => ({
          id: newId('whd'),
          ...ctx,
          endpointId: e.id,
          sessionId,
          eventId: event.id,
          eventType: event.type,
          idempotencyKey: deliveryKey(e.id, event.id),
          nextRetryAt: now,
        })),
        skipDuplicates: true,
      });
      return true;
    });
    if (!written) continue;
    const rows = await prisma.webhookDelivery.findMany({
      where: { ...ctx, eventId: event.id, status: DELIVERY_STATUS.pending, attempt: 0 },
      select: { id: true },
    });
    for (const r of rows) await enqueue(r.id, now, now);
    return endpoints.length;
  }
  throw new Error(`webhook fan-out for ${event.id} kept losing its endpoints; retrying later`);
}

/** The event's session, when it names one of this merchant + mode (for the delivery's FK). */
async function sessionOf(ctx: ScopeContext, payload: unknown): Promise<string | null> {
  const id = (payload as { session_id?: unknown } | null)?.session_id;
  if (typeof id !== 'string') return null;
  const s = await prisma.session.findFirst({ where: { id, ...ctx }, select: { id: true } });
  return s?.id ?? null;
}

/** Registers the fan-out for every merchant-facing type (and only those — ruling C23). */
export function registerWebhookHandlers(): void {
  for (const type of WebhookEventTypeValues) {
    if (!handlerNamesFor(type).includes(FANOUT_HANDLER)) {
      registerEventHandler(type, FANOUT_HANDLER, (event) => fanOutEvent(event).then(() => {}));
    }
  }
}

// ─── re-connect (rulings W9, W10) ───────────────────────────────────────────

/** Whether a send of `d` is in flight now (its claim lease on `next_retry_at` has not lapsed). */
function isInFlight(
  d: Pick<WebhookDelivery, 'status' | 'lastAttemptAt' | 'nextRetryAt'>,
  now: Date,
): boolean {
  return d.status === DELIVERY_STATUS.pending && holdsLease(d, now);
}

/** Whether a claim's lease on `d` is live (any status: a manual resend leases too). */
function holdsLease(d: Pick<WebhookDelivery, 'lastAttemptAt' | 'nextRetryAt'>, now: Date): boolean {
  return (
    d.lastAttemptAt !== null &&
    d.lastAttemptAt.getTime() > now.getTime() - SEND_LEASE_MS &&
    d.nextRetryAt !== null &&
    d.nextRetryAt.getTime() === d.lastAttemptAt.getTime() + SEND_LEASE_MS
  );
}

/** Statuses a re-connect moves to the new endpoint: retrying, and given up (still resendable). */
const MOVABLE = [DELIVERY_STATUS.pending, DELIVERY_STATUS.failed];

/**
 * A site re-connect (W9, W10), in the redeem transaction. The replaced connection's `pending` and
 * `failed` deliveries are locked `FOR UPDATE` first (a worker's claim, a single UPDATE, waits on
 * the lock and then finds the row changed, so it never sends), then each moves to the new
 * connection's active endpoint of the same mode: same row, event and payload, new
 * `endpoint_id` / `idempotency_key`; the next send signs with the new endpoint's secret.
 * - `pending` rows get a fresh window: attempt 0, `first_attempt_at` and `next_retry_at` now. A
 *   row whose claim lease is live keeps the lease (`last_attempt_at`, `next_retry_at`): the
 *   worker's conditional outcome write (`writeOutcome`) sees the move and records delivered (its
 *   send reached the site) or makes the row due now on the new endpoint.
 * - `failed` rows keep `failed` (the dashboard lists them under the new endpoint; resend works).
 * - When the new endpoint already has a row for the event (one row per endpoint and event), the
 *   old row is marked `superseded` instead and is never sent.
 * A mode with no active new endpoint leaves its rows where they are (they fail: endpoint deleted).
 */
export async function repointUndeliveredDeliveries(
  tx: Prisma.TransactionClient,
  fromConnectionId: string,
  toConnectionId: string,
  now = new Date(),
): Promise<{ moved: number; superseded: number }> {
  const out = { moved: 0, superseded: 0 };
  const [from, to] = await Promise.all([
    tx.webhookEndpoint.findMany({
      where: { connectionId: fromConnectionId },
      select: { id: true, livemode: true },
    }),
    tx.webhookEndpoint.findMany({
      where: { connectionId: toConnectionId, active: true },
      select: { id: true, livemode: true },
    }),
  ]);
  for (const target of to) {
    const sources = from.filter((e) => e.livemode === target.livemode).map((e) => e.id);
    if (sources.length === 0) continue;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM webhook_deliveries
      WHERE endpoint_id = ANY(${sources}) AND status IN ('pending', 'failed')
      ORDER BY id FOR UPDATE`;
    // C9: exactly the rows locked above. A row committed after the lock is not ours to move; the
    // fan-out writes under a share lock on the endpoint, so none can appear for a deactivated one.
    const rows = await tx.webhookDelivery.findMany({
      where: { id: { in: locked.map((r) => r.id) }, status: { in: MOVABLE } },
      orderBy: { id: 'asc' },
    });
    for (const d of rows) {
      const key = deliveryKey(target.id, d.eventId);
      const taken = await tx.webhookDelivery.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      });
      if (taken) {
        await tx.webhookDelivery.update({
          where: { id: d.id },
          data: {
            status: DELIVERY_STATUS.superseded,
            nextRetryAt: null,
            lastError: 'superseded: the site re-connected and its new endpoint has this event',
          },
        });
        out.superseded++;
        continue;
      }
      const leased = holdsLease(d, now);
      const schedule =
        d.status === DELIVERY_STATUS.pending
          ? {
              attempt: 0,
              firstAttemptAt: now,
              ...(leased
                ? {}
                : { nextRetryAt: now, lastAttemptAt: null, statusCode: null, lastError: null }),
            }
          : {};
      await tx.webhookDelivery.update({
        where: { id: d.id },
        data: { endpointId: target.id, idempotencyKey: key, ...schedule },
      });
      out.moved++;
    }
  }
  return out;
}

// ─── sending ────────────────────────────────────────────────────────────────

export interface AttemptResult {
  deliveryId: string;
  status: DeliveryStatus;
  statusCode: number | null;
  attempt: number;
  nextRetryAt: Date | null;
  error: string | null;
}

export interface AttemptOptions {
  now?: Date;
  /**
   * A manual send (resend, test send): goes now even when the row is waiting for its next retry
   * or already delivered / failed. Never while another send of the row is in flight.
   */
  manual?: boolean;
}

/**
 * Claims the delivery (a lease on `next_retry_at`), sends it and records the outcome. Returns
 * null when the row is not due / is in flight (another worker has it) / does not exist.
 *
 * Automatic sends: a failure schedules the next try `retryDelayMs(attempt)` later, capped at
 * 3 days after the first attempt; a failure at or past that mark marks the row `failed`.
 * Manual sends of a `delivered` / `failed` row (or a ping) are one-off: a failure leaves the
 * row `failed` without further retries.
 */
export async function attemptDelivery(
  deliveryId: string,
  opts: AttemptOptions = {},
): Promise<AttemptResult | null> {
  const now = opts.now ?? new Date();
  const before = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!before) return null;
  // A superseded row (W9: its event went to the re-connected site's endpoint) is never sent.
  if (before.status === DELIVERY_STATUS.superseded) return null;
  if (isInFlight(before, now)) return null;
  // C9: a manual send of a delivered / failed row leases it too; a second one waits for it.
  if (opts.manual && holdsLease(before, now)) return null;
  const due =
    before.status === DELIVERY_STATUS.pending &&
    (before.nextRetryAt === null || before.nextRetryAt <= now);
  if (!due && !opts.manual) return null;

  // Optimistic claim: only the caller that moves `updatedAt` from what it read sends.
  const claimed = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, updatedAt: before.updatedAt, status: before.status },
    data: {
      attempt: { increment: 1 },
      lastAttemptAt: now,
      nextRetryAt: new Date(now.getTime() + SEND_LEASE_MS),
      firstAttemptAt: before.firstAttemptAt ?? now,
    },
  });
  if (claimed.count !== 1) return null;
  const attempt = before.attempt + 1;
  const firstAttemptAt = before.firstAttemptAt ?? now;
  const oneOff = before.status !== DELIVERY_STATUS.pending || before.eventType === PING_EVENT;

  const outcome = await send(before, now);
  let status: DeliveryStatus;
  let nextRetryAt: Date | null = null;
  if (outcome.ok) {
    status = DELIVERY_STATUS.delivered;
  } else if (oneOff || outcome.permanent) {
    status = DELIVERY_STATUS.failed;
  } else {
    const deadline = firstAttemptAt.getTime() + WEBHOOK_RETRY_WINDOW_MS;
    if (now.getTime() >= deadline) {
      status = DELIVERY_STATUS.failed;
    } else {
      status = DELIVERY_STATUS.pending;
      nextRetryAt = new Date(Math.min(now.getTime() + retryDelayMs(attempt), deadline));
    }
  }
  const claim: Claim = {
    id: deliveryId,
    endpointId: before.endpointId,
    status: before.status,
    leasedAt: now,
  };
  const written = await writeOutcome(claim, outcome, { status, nextRetryAt }, now);
  if (written.nextRetryAt) await enqueue(deliveryId, written.nextRetryAt, now);
  if (!outcome.ok && written.status === DELIVERY_STATUS.failed && !oneOff) {
    log('warn', 'webhook delivery gave up', { deliveryId, attempt, error: outcome.error });
  }
  return {
    deliveryId,
    status: written.status,
    statusCode: outcome.statusCode,
    attempt,
    nextRetryAt: written.nextRetryAt,
    error: outcome.ok ? null : outcome.error,
  };
}

/** What a worker holds after its claim: the row as it claimed it, and its lease token. */
interface Claim {
  id: string;
  endpointId: string;
  status: string;
  /** `last_attempt_at` written by the claim (the lease token). */
  leasedAt: Date;
}

/**
 * Records a send's outcome only while the worker still holds its claim (W10): same endpoint,
 * same status, same lease token. Otherwise the row changed under the send and is never
 * overwritten blindly:
 * - superseded (a re-connect gave the event to the new endpoint's own row): left as is;
 * - moved to another endpoint by a re-connect: if this send reached the site, the event was
 *   delivered (once) and the row says so; if not, the row stays where it is — a `pending` row due
 *   now on its new endpoint, a `failed` row failed;
 * - anything else (a later claim took over after the lease lapsed): left to that claim.
 * Returns the row's status and next retry as they now stand.
 */
async function writeOutcome(
  claim: Claim,
  outcome: SendOutcome,
  next: { status: DeliveryStatus; nextRetryAt: Date | null },
  now: Date,
): Promise<{ status: DeliveryStatus; nextRetryAt: Date | null }> {
  const result = {
    statusCode: outcome.statusCode,
    lastError: outcome.ok ? null : outcome.error,
  };
  const held = await prisma.webhookDelivery.updateMany({
    where: {
      id: claim.id,
      endpointId: claim.endpointId,
      status: claim.status,
      lastAttemptAt: claim.leasedAt,
    },
    data: {
      ...result,
      status: next.status,
      nextRetryAt: next.nextRetryAt,
      ...(outcome.ok ? { deliveredAt: now } : {}),
    },
  });
  if (held.count === 1) return next;
  const row = await prisma.webhookDelivery.findUnique({ where: { id: claim.id } });
  const as = (r: { status: string; nextRetryAt: Date | null } | null) => ({
    status: (r?.status ?? next.status) as DeliveryStatus,
    nextRetryAt: r?.status === DELIVERY_STATUS.pending ? (r?.nextRetryAt ?? null) : null,
  });
  if (row?.status === DELIVERY_STATUS.superseded && outcome.ok) {
    // C9: superseded while this send was on the wire, and the send reached the site: the event is
    // delivered, so the new endpoint's own row for it must not send it again.
    await markSuccessorDelivered(row, result, now);
    return as(row);
  }
  if (!row || row.status === DELIVERY_STATUS.superseded || row.endpointId === claim.endpointId) {
    return as(row);
  }
  log('info', 'webhook delivery moved by a re-connect during its send', {
    deliveryId: claim.id,
    sent: outcome.ok,
  });
  const unchanged = { id: row.id, updatedAt: row.updatedAt };
  if (outcome.ok) {
    await prisma.webhookDelivery.updateMany({
      where: unchanged,
      data: { ...result, status: DELIVERY_STATUS.delivered, nextRetryAt: null, deliveredAt: now },
    });
  } else if (row.status === DELIVERY_STATUS.pending) {
    await prisma.webhookDelivery.updateMany({
      where: unchanged,
      data: { ...result, nextRetryAt: now },
    });
  }
  return as(await prisma.webhookDelivery.findUnique({ where: { id: claim.id } }));
}

/**
 * The row a re-connect gave the superseded delivery's event to — on the live successor
 * connection's active endpoint of the same mode — becomes `delivered`, unless it is being sent
 * right now (its own send then records the outcome).
 */
async function markSuccessorDelivered(
  superseded: WebhookDelivery,
  result: { statusCode: number | null; lastError: string | null },
  now: Date,
): Promise<void> {
  const tenant = { merchantId: superseded.merchantId, livemode: superseded.livemode };
  const old = await prisma.webhookEndpoint.findFirst({
    where: { id: superseded.endpointId, ...tenant },
    select: { connectionId: true },
  });
  if (!old?.connectionId) return;
  const live = await liveConnectionId(old.connectionId, superseded.merchantId);
  if (!live) return;
  const targets = await prisma.webhookDelivery.findMany({
    where: {
      ...tenant,
      eventId: superseded.eventId,
      status: DELIVERY_STATUS.pending,
      endpoint: { connectionId: live, active: true },
    },
  });
  for (const t of targets) {
    if (isInFlight(t, now)) continue;
    await prisma.webhookDelivery.updateMany({
      where: { id: t.id, updatedAt: t.updatedAt, status: DELIVERY_STATUS.pending },
      data: { ...result, status: DELIVERY_STATUS.delivered, nextRetryAt: null, deliveredAt: now },
    });
  }
}

type SendOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode: number | null; error: string; permanent: boolean };

async function send(d: WebhookDelivery, now: Date): Promise<SendOutcome> {
  const fail = (error: string, permanent = false, statusCode: number | null = null) =>
    ({ ok: false, statusCode, error: error.slice(0, MAX_ERROR_LEN), permanent }) as const;
  const tenant = { merchantId: d.merchantId, livemode: d.livemode };
  if (beforeSend) await beforeSend(d.id);
  const [endpoint, event] = await Promise.all([
    prisma.webhookEndpoint.findFirst({ where: { id: d.endpointId, ...tenant } }),
    prisma.event.findFirst({ where: { id: d.eventId, ...tenant } }),
  ]);
  if (!endpoint || !endpoint.active) return fail('endpoint deleted', true);
  if (!event) return fail('event not found', true);
  // C23 allowlist again at send time, and test/live never cross (the composite FKs already pin
  // endpoint, event and delivery to one mode; checked here so a mistake can never send).
  if (!isDeliverableEventType(event.type) && event.type !== PING_EVENT) {
    return fail(`event type ${event.type} is not deliverable`, true);
  }
  if (event.livemode !== endpoint.livemode || endpoint.livemode !== d.livemode) {
    return fail('mode mismatch', true);
  }
  // A connection's endpoint only ever gets that connection's events. The fan-out already filters;
  // checked again so a stray row or a resend can never cross sites. (A re-connect deactivates the
  // old connection's endpoints, which the `active` check above refuses.) A ping is for the endpoint.
  if (
    endpoint.connectionId !== null &&
    event.type !== PING_EVENT &&
    !forConnection(endpoint, await eventConnectionId(event, tenant))
  ) {
    return fail('connection mismatch', true);
  }
  const strict = strictHostPolicy(endpoint.livemode);
  let secrets: string[];
  try {
    if (strict) {
      const url = new URL(endpoint.url);
      if (url.protocol !== 'https:') return fail('webhook endpoints must use https://', true);
      await assertPublicHost(url.hostname);
    }
    secrets = await signingSecrets(endpoint, now);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const body = webhookBody(event);
  const t = Math.floor(now.getTime() / 1000);
  try {
    const res = await transport({
      url: endpoint.url,
      livemode: endpoint.livemode,
      strict,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Tendr-Webhooks/1.0',
        'tendr-event-id': event.id,
        [SIGNATURE_HEADER.toLowerCase()]: signPayload(secrets[0]!, t, body, secrets.slice(1)),
      },
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status };
    return fail(`HTTP ${res.status}`, false, res.status);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Queues every pending delivery whose retry is due (and those whose job was lost). Returns how
 * many were queued. Runs every minute in the worker.
 */
export async function sweepDueDeliveries(now = new Date(), limit = 500): Promise<number> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: DELIVERY_STATUS.pending, nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  for (const d of due) await enqueue(d.id, now, now);
  return due.length;
}

// ─── endpoint management (dashboard) ────────────────────────────────────────

export interface EndpointView {
  id: string;
  url: string;
  events: string[];
  livemode: boolean;
  active: boolean;
  created_at: string;
}

const view = (e: WebhookEndpoint): EndpointView => ({
  id: e.id,
  url: e.url,
  events: e.events.includes('*') ? [] : e.events,
  livemode: e.livemode,
  active: e.active,
  created_at: e.createdAt.toISOString(),
});

/** A new endpoint signing secret (`whsec_` + 64 hex); stored only through `putSecret`. */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('hex')}`;

/** Creates an endpoint; the signing secret is returned here and on rotate only. */
export async function createEndpoint(
  ctx: ScopeContext,
  input: { url: string; events?: WebhookEventType[] },
): Promise<{ endpoint: EndpointView; secret: string }> {
  const url = await validateEndpointUrl(input.url, ctx.livemode);
  const secret = newWebhookSecret();
  const secretRef = await putSecret(secret, WEBHOOK_SECRET_PURPOSE);
  const events = input.events && input.events.length > 0 ? [...new Set(input.events)] : ['*'];
  const row = await scopedDb(ctx).webhookEndpoint.create({
    data: { id: newId('whe'), ...ctx, url, secretRef, events },
  });
  return { endpoint: view(row), secret };
}

export async function listEndpoints(ctx: ScopeContext): Promise<EndpointView[]> {
  const rows = await scopedDb(ctx).webhookEndpoint.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(view);
}

async function activeEndpoint(ctx: ScopeContext, id: string): Promise<WebhookEndpoint> {
  const row = await scopedDb(ctx).webhookEndpoint.findFirst({ where: { id, active: true } });
  if (!row) throw notFound('Webhook endpoint not found');
  return row;
}

/**
 * Deletes an endpoint: it stops receiving events at once (pending retries end as `failed`).
 * The row is kept, deactivated, because its delivery history references it.
 */
export async function deleteEndpoint(ctx: ScopeContext, id: string): Promise<{ id: string }> {
  await activeEndpoint(ctx, id);
  await scopedDb(ctx).webhookEndpoint.updateMany({ where: { id }, data: { active: false } });
  return { id };
}

/**
 * Replaces the signing secret; returns the new one. For `ROTATION_OVERLAP_MS` (24 h) after, every
 * send also carries a second `v1=` signed with the old secret, so the merchant can switch without
 * dropping events. Rotating again ends the earlier overlap (only the latest old secret overlaps).
 */
export async function rotateEndpointSecret(
  ctx: ScopeContext,
  id: string,
  now = new Date(),
): Promise<{ endpoint: EndpointView; secret: string; previous_secret_expires_at: string }> {
  const e = await activeEndpoint(ctx, id);
  const secret = newWebhookSecret();
  const secretRef = await putSecret(secret, WEBHOOK_SECRET_PURPOSE);
  const previousSecretExpiresAt = new Date(now.getTime() + ROTATION_OVERLAP_MS);
  await scopedDb(ctx).webhookEndpoint.updateMany({
    where: { id },
    data: { secretRef, previousSecretRef: e.secretRef, previousSecretExpiresAt },
  });
  if (e.previousSecretRef) {
    await prisma.secret.deleteMany({ where: { id: e.previousSecretRef } });
  }
  return {
    endpoint: view({ ...e, secretRef }),
    secret,
    previous_secret_expires_at: previousSecretExpiresAt.toISOString(),
  };
}

export interface DeliveryView {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  session_id: string | null;
  status: string;
  attempts: number;
  status_code: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const deliveryView = (d: WebhookDelivery): DeliveryView => ({
  id: d.id,
  endpoint_id: d.endpointId,
  event_id: d.eventId,
  event_type: d.eventType,
  session_id: d.sessionId,
  status: d.status,
  attempts: d.attempt,
  status_code: d.statusCode,
  last_error: d.lastError,
  next_retry_at: d.status === DELIVERY_STATUS.pending ? iso(d.nextRetryAt) : null,
  first_attempt_at: iso(d.firstAttemptAt),
  last_attempt_at: iso(d.lastAttemptAt),
  delivered_at: iso(d.deliveredAt),
  created_at: d.createdAt.toISOString(),
});

export async function listDeliveries(ctx: ScopeContext, endpointId: string) {
  await activeEndpoint(ctx, endpointId);
  const rows = await scopedDb(ctx).webhookDelivery.findMany({
    where: { endpointId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(deliveryView);
}

/** Sends a `ping` event to one endpoint now and returns the delivery. */
export async function sendTestEvent(ctx: ScopeContext, endpointId: string): Promise<DeliveryView> {
  await activeEndpoint(ctx, endpointId);
  const deliveryId = await tenantTransaction(ctx, async (tx) => {
    // A ping is an event (so the delivery and its body have a stable id), but never enters the
    // outbox: nothing fans it out.
    const eventId = newId('evt');
    await tx.event.create({
      data: {
        id: eventId,
        ...ctx,
        aggregateType: 'webhook_endpoint',
        aggregateId: endpointId,
        type: PING_EVENT,
        payload: { endpoint_id: endpointId },
      },
    });
    const id = newId('whd');
    await tx.webhookDelivery.create({
      data: {
        id,
        ...ctx,
        endpointId,
        eventId,
        eventType: PING_EVENT,
        idempotencyKey: deliveryKey(endpointId, eventId),
      },
    });
    return id;
  });
  await attemptDelivery(deliveryId, { manual: true });
  return getDelivery(ctx, deliveryId);
}

async function getDelivery(ctx: ScopeContext, id: string): Promise<DeliveryView> {
  const d = await scopedDb(ctx).webhookDelivery.findFirst({ where: { id } });
  if (!d) throw notFound('Webhook delivery not found');
  return deliveryView(d);
}

/**
 * Sends a delivery again now, with the same event id and body (only the signature timestamp is
 * new). Allowed in any state — after give-up too — but not while a send is in flight.
 */
export async function resendDelivery(ctx: ScopeContext, id: string): Promise<DeliveryView> {
  const d = await scopedDb(ctx).webhookDelivery.findFirst({ where: { id } });
  if (!d) throw notFound('Webhook delivery not found');
  const endpoint = await scopedDb(ctx).webhookEndpoint.findFirst({ where: { id: d.endpointId } });
  if (!endpoint?.active) {
    throw conflict('The endpoint of this delivery was deleted');
  }
  const res = await attemptDelivery(id, { manual: true });
  if (!res) throw conflict('This delivery is being sent right now; try again in a moment');
  return getDelivery(ctx, id);
}
