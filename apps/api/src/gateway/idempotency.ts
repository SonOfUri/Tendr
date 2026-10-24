// Idempotency keys for `POST /v1/*` (spec: `idempotency_keys`).
//
// A request carrying `Idempotency-Key` claims the row (merchant, mode, principal, key) before
// the handler runs. Keys are namespaced per credential (`principal_ref` =
// `${kind}:${principalRef}`), so a publishable key or session client can never have the secret
// key's stored response replayed to it, and vice versa. A retry with the same key and the same request replays the stored response
// (`Idempotent-Replayed: true`); a different request is 409 IDEMPOTENCY_CONFLICT; a retry
// while the first is still running is 409 IDEMPOTENCY_IN_PROGRESS. 5xx responses are not
// stored, so the client can retry. A row whose lock is older than 60 s (its request died
// without answering) is taken over; rows expire after 24 h and are then replaced.
//
// Runs in `preHandler`: after authentication AND request-signature verification, so an
// unsigned or forged request can never claim or replay a key.
//
// Every claim is a single conditional statement, so concurrent requests have exactly one
// winner. All lock/expiry times are database time (UTC, matching Prisma's DateTime columns),
// never the app clock, so instances with skewed clocks agree.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isV1 } from './auth.js';
import { principalRef, type Principal } from './principal.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const MAX_KEY_LENGTH = 255;

/** Database "now" in UTC, the convention Prisma uses for `timestamp(3)` columns. */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
const TTL = Prisma.sql`interval '24 hours'`;
const LOCK_TIMEOUT = Prisma.sql`interval '60 seconds'`;

/** sha256 over method, URL (path + query) and the raw body bytes; newline-separated. */
export function requestHash(method: string, url: string, rawBody: Buffer): string {
  return createHash('sha256').update(`${method}\n${url}\n`).update(rawBody).digest('hex');
}

const idempotencyError = (code: 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_IN_PROGRESS') =>
  new AppError(
    code,
    code === 'IDEMPOTENCY_CONFLICT'
      ? 'Idempotency key was already used with a different request'
      : 'A request with this idempotency key is still in progress',
    409,
  );

type Scope = { merchantId: string; livemode: boolean; principalRef: string; key: string };

/** The idempotency namespace of a principal: its kind plus its credential id. */
export function idempotencyPrincipalRef(p: Principal): string {
  return `${p.kind}:${principalRef(p)}`;
}

type ExistingRow = {
  status: 'in_progress' | 'completed';
  request_hash: string;
  response_code: number | null;
  response_body: unknown;
  stale: boolean;
};

type Outcome =
  | { kind: 'claimed'; token: string }
  | { kind: 'replay'; statusCode: number; body: string }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

const rowWhere = (s: Scope) =>
  Prisma.sql`merchant_id = ${s.merchantId} AND livemode = ${s.livemode}
    AND principal_ref = ${s.principalRef} AND key = ${s.key}`;

/**
 * Claims the key or classifies the existing row. Each claim path is one statement; the row
 * `id` is re-generated on every claim and acts as the owner's token, so a request whose lock
 * was taken over can no longer complete or delete the row.
 */
async function claim(s: Scope, hash: string): Promise<Outcome> {
  // A concurrent 5xx cleanup can delete the row between statements; a few rounds suffice.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = newId('idem');

    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO idempotency_keys
        (id, merchant_id, livemode, principal_ref, key, request_hash, status, locked_at,
         expires_at, updated_at)
      VALUES
        (${token}, ${s.merchantId}, ${s.livemode}, ${s.principalRef}, ${s.key}, ${hash},
         'in_progress', ${NOW}, ${NOW} + ${TTL}, ${NOW})
      ON CONFLICT (merchant_id, livemode, principal_ref, key) DO NOTHING
      RETURNING id`;
    if (inserted.length > 0) return { kind: 'claimed', token };

    // Expired rows are ignored and replaced (any status, any previous request).
    const replaced = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE idempotency_keys
      SET id = ${token}, request_hash = ${hash}, status = 'in_progress', locked_at = ${NOW},
          expires_at = ${NOW} + ${TTL}, response_code = NULL, response_body = NULL,
          updated_at = ${NOW}
      WHERE ${rowWhere(s)} AND expires_at < ${NOW}
      RETURNING id`;
    if (replaced.length > 0) return { kind: 'claimed', token };

    // Stale lock: the owner died without answering. Only the same request may take it over.
    const takenOver = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE idempotency_keys
      SET id = ${token}, locked_at = ${NOW}, updated_at = ${NOW}
      WHERE ${rowWhere(s)} AND status = 'in_progress' AND request_hash = ${hash}
        AND locked_at < ${NOW} - ${LOCK_TIMEOUT}
      RETURNING id`;
    if (takenOver.length > 0) return { kind: 'claimed', token };

    const [row] = await prisma.$queryRaw<ExistingRow[]>`
      SELECT status, request_hash, response_code, response_body,
             locked_at < ${NOW} - ${LOCK_TIMEOUT} AS stale
      FROM idempotency_keys WHERE ${rowWhere(s)}`;
    if (!row) continue; // deleted under us (5xx cleanup): try to claim again
    if (row.status === 'in_progress') {
      // A stale lock left by a different request is a conflict, not something to wait on.
      if (row.stale && row.request_hash !== hash) return { kind: 'conflict' };
      return { kind: 'in_progress' };
    }
    if (row.request_hash !== hash) return { kind: 'conflict' };
    return {
      kind: 'replay',
      statusCode: row.response_code ?? 200,
      body: typeof row.response_body === 'string' ? row.response_body : '',
    };
  }
  return { kind: 'in_progress' };
}

/** Owner tokens of the requests that claimed a key, until the row is completed or released. */
const claims = new WeakMap<FastifyRequest, string>();

async function release(token: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM idempotency_keys WHERE id = ${token} AND status = 'in_progress'`;
}

async function complete(token: string, statusCode: number, body: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE idempotency_keys
    SET status = 'completed', response_code = ${statusCode},
        response_body = to_jsonb(${body}::text), updated_at = ${NOW}
    WHERE id = ${token} AND status = 'in_progress'`;
}

function payloadText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload === null || payload === undefined) return '';
  return null; // a stream: cannot be stored
}

const idempotencyPlugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || !isV1(req.routeOptions.url) || !req.principal) return;
    const header = req.headers[IDEMPOTENCY_HEADER];
    if (header === undefined) return;
    if (typeof header !== 'string' || header.length < 1 || header.length > MAX_KEY_LENGTH) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Idempotency-Key must be 1-${MAX_KEY_LENGTH} characters`,
        400,
      );
    }

    const { merchantId, livemode } = req.principal;
    const hash = requestHash(req.method, req.url, req.rawBody ?? Buffer.alloc(0));
    const outcome = await claim(
      { merchantId, livemode, principalRef: idempotencyPrincipalRef(req.principal), key: header },
      hash,
    );
    switch (outcome.kind) {
      case 'claimed':
        claims.set(req, outcome.token);
        return;
      case 'conflict':
        throw idempotencyError('IDEMPOTENCY_CONFLICT');
      case 'in_progress':
        throw idempotencyError('IDEMPOTENCY_IN_PROGRESS');
      case 'replay':
        return reply
          .code(outcome.statusCode)
          .header(REPLAYED_HEADER, 'true')
          .type('application/json; charset=utf-8')
          .send(outcome.body);
    }
  });

  // Store the response before it is sent, so a retry that arrives after it sees the row
  // completed. Covers error-handler replies too (a throwing handler's 500 passes through here).
  app.addHook('onSend', async (req, reply, payload) => {
    const token = claims.get(req);
    if (token === undefined) return payload;
    claims.delete(req);
    const body = payloadText(payload);
    try {
      if (reply.statusCode >= 500 || body === null) await release(token);
      else await complete(token, reply.statusCode, body);
    } catch (err) {
      // The row stays in_progress; the 60 s lock timeout lets a retry take it over.
      log('error', 'failed to record idempotency key outcome', {
        requestId: req.id,
        err: String(err),
      });
    }
    return payload;
  });

  // Safety net: a claimed request that never reached onSend (e.g. the reply failed to
  // serialise) releases its key so the client can retry.
  app.addHook('onResponse', async (req) => {
    const token = claims.get(req);
    if (token === undefined) return;
    claims.delete(req);
    await release(token).catch((err: unknown) => {
      log('error', 'failed to release idempotency key', { requestId: req.id, err: String(err) });
    });
  });
};

export const idempotency = fp(idempotencyPlugin, { name: 'tendr-idempotency' });
