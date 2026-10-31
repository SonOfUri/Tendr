// Connect: the authorization-code + PKCE flow, connection status, and the connected-sites list
// (WooCommerce plugin spec §2, §3 "Go live").
//
// Approval (`authorize`) creates the connection — its keys, endpoints and the checkout domain —
// and a single-use code in ONE transaction. The connection's raw credentials exist only in that
// transaction's memory and, KeyVault-encrypted, in a `secrets` row linked to the code: the plugin's
// server-to-server `redeem` (`POST /v1/connect/token`) is the only way to read them, exactly once.
// Only the code's sha256 is stored. A connection never redeemed is revoked by the sweeper.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  CONNECT_CODE_TTL_MS,
  ConnectReplaceRequestSchema,
  ConnectTokenRequestSchema,
  ConnectTokenResponseSchema,
  type ConnectAuthorizeRequest,
  type ConnectBlockingCode,
  type ConnectedSite,
  type ConnectReplaceResponse,
  type ConnectStatusResponse,
  type ConnectTokenResponse,
} from '@tendr/contracts';
import { goLiveStatus, signerPasskeyCount } from '../accounts/accounts.js';
import { readinessFor, type CheckoutCtx } from '../checkout/sessions.js';
import { repointUndeliveredDeliveries } from '../checkout/webhooks.js';
import { env } from '../env.js';
import { recordEvent } from '../events/record.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { liveModeOpen, liveModeUnavailable } from '../lib/live-mode.js';
import { log } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { deleteSecret, putSecret, takeSecret } from '../secrets/secrets.js';
import { createConnection, revokeConnection, siteOriginOf } from './connections.js';

type Tx = Prisma.TransactionClient;

/** KeyVault purpose of a connection's issued credentials, held until `/token`. */
export const CONNECT_CREDENTIALS_PURPOSE = 'connect_credentials';
/** A connection whose credentials were never redeemed is revoked this long after approval. */
export const UNREDEEMED_CONNECTION_TTL_MS = 10 * 60_000;

// ─── authorize ───────────────────────────────────────────────────────────────

const invalidReturnUrl = (why: string) =>
  new AppError('VALIDATION_ERROR', `The return URL is not valid: ${why}`, 400, {
    field: 'return_url',
  });

/**
 * Checks `return_url`: http(s), no credentials, no fragment, and the same origin as the site.
 * Returns it parsed.
 */
function checkReturnUrl(returnUrl: string, siteOrigin: string): URL {
  let u: URL;
  try {
    u = new URL(returnUrl.trim());
  } catch {
    throw invalidReturnUrl('not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalidReturnUrl('must be http(s)');
  if (u.username || u.password) throw invalidReturnUrl('credentials are not allowed');
  // `new URL` drops an empty fragment (`…#`), so look at the raw string as well.
  if (u.hash || returnUrl.includes('#')) throw invalidReturnUrl('a fragment is not allowed');
  if (u.origin !== siteOrigin) throw invalidReturnUrl('must be on the same origin as the site');
  return u;
}

/**
 * Approves a connection for `actor`'s store (the route checked owner/admin and step-up): creates
 * the connection (`createConnection`) and a 60 s single-use authorization code bound to it, the
 * return URL and the PKCE challenge, in one transaction. Returns where the popup goes next:
 * `return_url?code=…&state=…`.
 */
export async function authorize(
  actor: { merchantId: string; userId: string },
  input: ConnectAuthorizeRequest,
): Promise<{ redirect: string }> {
  const site = siteOriginOf(input.site_url);
  const target = checkReturnUrl(input.return_url, site.origin);
  const code = randomBytes(32).toString('base64url');

  await prisma.$transaction(async (tx) => {
    const { connection, issued } = await createConnection(tx, {
      merchantId: actor.merchantId,
      userId: actor.userId,
      siteUrl: input.site_url,
      platform: input.platform,
    });
    const credentials: Pick<ConnectTokenResponse, 'test' | 'live'> = {
      test: {
        secret_key: issued.test.secretKey,
        publishable_key: issued.test.publishableKey,
        webhook_secret: issued.test.webhookSecret,
      },
      live: {
        secret_key: issued.live.secretKey,
        publishable_key: issued.live.publishableKey,
        webhook_secret: issued.live.webhookSecret,
      },
    };
    const credentialsRef = await putSecret(
      JSON.stringify(credentials),
      CONNECT_CREDENTIALS_PURPOSE,
      tx,
    );
    await tx.connectAuthCode.create({
      data: {
        id: newId('cac'),
        codeHash: sha256(code),
        connectionId: connection.id,
        returnUrl: target.toString(),
        codeChallenge: input.code_challenge,
        credentialsRef,
        expiresAt: new Date(Date.now() + CONNECT_CODE_TTL_MS),
      },
    });
  });

  target.searchParams.set('code', code);
  target.searchParams.set('state', input.state);
  return { redirect: target.toString() };
}

// ─── token ───────────────────────────────────────────────────────────────────

/** Every `/token` failure: one code, one message, no details. */
export const invalidGrant = () =>
  new AppError('INVALID_GRANT', 'The authorization code is invalid or expired', 400);

/** Compares two strings in constant time (for their length) via their sha256 digests. */
function digestEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

/** A site's identity for matching: its origin plus subdirectory path, or null when not valid. */
function siteKey(siteUrl: string): string | null {
  try {
    const s = siteOriginOf(siteUrl);
    return `${s.origin}${s.path}`;
  } catch {
    return null;
  }
}

/** Compared against when the code is unknown, so that path does the same work. */
const DUMMY_CHALLENGE = 'A'.repeat(43);

/**
 * Exchanges an authorization code for the connection's credentials (`POST /v1/connect/token`).
 * Checks, all evaluated before deciding: the code exists, is unused and unexpired; the connection
 * is live and the store active; `base64url(sha256(code_verifier)) === code_challenge`; `site_url`
 * is the connected site. Redemption is atomic: the connection's `redeemed_at` and the code's
 * `used_at` are set by conditional updates, so concurrent calls have exactly one winner. The
 * stored credentials are decrypted and deleted in the same transaction. Any failure is
 * INVALID_GRANT.
 */
export async function redeem(body: unknown): Promise<ConnectTokenResponse> {
  const parsed = ConnectTokenRequestSchema.safeParse(body);
  if (!parsed.success) throw invalidGrant();
  const input = parsed.data;
  const now = new Date();

  const row = await prisma.connectAuthCode.findUnique({
    where: { codeHash: sha256(input.code) },
    include: {
      connection: {
        select: {
          id: true,
          merchantId: true,
          siteUrl: true,
          revokedAt: true,
          redeemedAt: true,
          merchant: { select: { status: true } },
        },
      },
    },
  });
  const challenge = createHash('sha256').update(input.code_verifier).digest('base64url');
  const pkceOk = digestEqual(challenge, row?.codeChallenge ?? DUMMY_CHALLENGE);
  const requested = siteKey(input.site_url) ?? '';
  const connected = (row && siteKey(row.connection.siteUrl)) ?? '\u0000';
  const siteOk = digestEqual(requested, connected);
  const ref = row?.credentialsRef ?? null;
  const ok =
    row !== null &&
    pkceOk &&
    siteOk &&
    ref !== null &&
    row.usedAt === null &&
    row.expiresAt > now &&
    row.connection.revokedAt === null &&
    row.connection.redeemedAt === null &&
    row.connection.merchant.status === 'active';
  if (!ok || !row || !ref) throw invalidGrant();

  const merchantId = row.connection.merchantId;
  const site = connected;
  return prisma.$transaction(async (tx) => {
    // One lock order everywhere (revokeConnection, the sweeper, a dashboard removal): the store,
    // then the connection, then its codes.
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${merchantId} FOR UPDATE`;
    const claimed = await tx.connection.updateMany({
      where: { id: row.connectionId, revokedAt: null, redeemedAt: null },
      data: { redeemedAt: now },
    });
    if (claimed.count !== 1) throw invalidGrant();
    const used = await tx.connectAuthCode.updateMany({
      where: { id: row.id, usedAt: null, credentialsRef: ref, expiresAt: { gt: now } },
      data: { usedAt: now, credentialsRef: null },
    });
    if (used.count !== 1) throw invalidGrant();
    const raw = await takeSecret(ref, tx);
    if (raw === null) throw invalidGrant();
    let credentials: Pick<ConnectTokenResponse, 'test' | 'live'>;
    try {
      credentials = ConnectTokenResponseSchema.pick({ test: true, live: true }).parse(
        JSON.parse(raw),
      );
    } catch {
      // Never log `raw`: it is the connection's keys.
      throw invalidGrant();
    }

    await replacePreviousConnections(tx, merchantId, row.connectionId, site);

    const connection = await tx.connection.findUniqueOrThrow({
      where: { id: row.connectionId },
      select: { merchantId: true },
    });
    const merchant = await tx.merchant.findUniqueOrThrow({
      where: { id: connection.merchantId },
      select: { id: true, name: true },
    });
    const accounts = await tx.merchantAccount.findMany({
      where: { merchantId: merchant.id },
      select: { livemode: true, nearAccountId: true },
    });
    const accountOf = (livemode: boolean) =>
      accounts.find((a) => a.livemode === livemode)?.nearAccountId ?? null;
    return {
      connection_id: row.connectionId,
      store: {
        id: merchant.id,
        name: merchant.name,
        test_account: accountOf(false) ?? '',
        live_account: accountOf(true),
      },
      ...credentials,
    };
  });
}

/**
 * Re-connect (spec §2.9, ruling W5): once a new connection for a site is redeemed, the store's
 * other live connections for the same site (origin + path) are replaced by it
 * (`applyReplacement`). Runs in the redeem transaction, holding the store lock, so an approval
 * that is never redeemed never breaks a working site.
 */
async function replacePreviousConnections(
  tx: Tx,
  merchantId: string,
  connectionId: string,
  site: string,
): Promise<void> {
  const fresh = await tx.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const peers = await tx.connection.findMany({
    where: {
      merchantId,
      siteOrigin: fresh.siteOrigin,
      revokedAt: null,
      id: { not: connectionId },
    },
    select: { id: true, siteUrl: true },
  });
  for (const peer of peers) {
    if (siteKey(peer.siteUrl) !== site) continue; // another subdirectory site on that origin
    await applyReplacement(tx, merchantId, peer.id, connectionId);
  }
}

/** Audit event (never a webhook): a connection handed its site's orders to its successor. */
export const CONNECTION_REPLACED = 'connection.replaced';

/**
 * `oldId` is replaced by `successorId` (W5/W8/W9), in the caller's transaction (store locked):
 * - revoked as a Disconnect from the site would (`'site'`: the domain stays), but as a replacement,
 *   so its open sessions stay payable — they now report to the successor;
 * - `replaced_by_id` → the successor (W8), so webhooks for its earlier orders follow the site and
 *   the successor may read, cancel and refund them;
 * - its undelivered webhooks go to the successor's endpoints, each event once (W9);
 * - credentials of an older approval never redeemed are dropped;
 * - when it owned the domain (`added_domain`) and the successor owns none, ownership passes on, so
 *   a later dashboard removal can still take it away.
 */
async function applyReplacement(
  tx: Tx,
  merchantId: string,
  oldId: string,
  successorId: string,
): Promise<void> {
  const old = await tx.connection.findUniqueOrThrow({
    where: { id: oldId },
    select: { addedDomain: true },
  });
  await revokeConnection(tx, oldId, 'site', { replacement: true });
  await tx.connection.update({ where: { id: oldId }, data: { replacedById: successorId } });
  const repointed = await repointUndeliveredDeliveries(tx, oldId, successorId);
  await dropHeldCredentials(tx, oldId);
  const successor = await tx.connection.findUniqueOrThrow({
    where: { id: successorId },
    select: { addedDomain: true },
  });
  if (old.addedDomain && !successor.addedDomain) {
    await tx.connection.update({ where: { id: oldId }, data: { addedDomain: null } });
    await tx.connection.update({
      where: { id: successorId },
      data: { addedDomain: old.addedDomain },
    });
  }
  for (const livemode of [false, true]) {
    await recordEvent(
      tx,
      { merchantId, livemode },
      {
        aggregateType: 'connection',
        aggregateId: oldId,
        type: CONNECTION_REPLACED,
        payload: {
          connection_id: oldId,
          replaced_by: successorId,
          moved_deliveries: repointed.moved,
          superseded_deliveries: repointed.superseded,
        },
      },
    );
  }
}

const replaceRefused = (message: string) => new AppError('CONFLICT', message, 409);

/**
 * `POST /v1/connect/replace` (A3, spec §2.9): a site that re-connected at a new address (a domain
 * move, http→https, a subdirectory change) proves the old connection with its key and hands it to
 * the new one. The successor must be another live, redeemed connection of the same store, created
 * after the old one, and not itself replaced. Unknown or another store's → NOT_FOUND; otherwise
 * refused → CONFLICT. The old connection is live (its key authenticated this call), so a second
 * replace with the same key is already 401.
 */
export async function replaceConnection(
  ctx: { merchantId: string; connectionId: string },
  input: unknown,
): Promise<ConnectReplaceResponse> {
  const { successor_connection_id: successorId } = ConnectReplaceRequestSchema.parse(input);
  const oldId = ctx.connectionId;
  await prisma.$transaction(async (tx) => {
    // Lock order as everywhere: the store, then the connections (by id).
    await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${ctx.merchantId} FOR UPDATE`;
    await tx.$queryRaw`
      SELECT id FROM connections WHERE id IN (${oldId}, ${successorId}) ORDER BY id FOR UPDATE`;
    const successor = await tx.connection.findFirst({
      where: { id: successorId, merchantId: ctx.merchantId },
    });
    if (!successor) throw notFound('Connection not found');
    if (successorId === oldId) throw replaceRefused('A connection cannot replace itself');
    const old = await tx.connection.findFirstOrThrow({
      where: { id: oldId, merchantId: ctx.merchantId },
    });
    if (old.revokedAt !== null || old.replacedById !== null) {
      throw replaceRefused('This connection was already disconnected or replaced');
    }
    if (successor.revokedAt !== null || successor.replacedById !== null) {
      throw replaceRefused('The new connection is no longer active');
    }
    if (successor.redeemedAt === null) {
      throw replaceRefused('The new connection has not finished connecting');
    }
    if (successor.createdAt <= old.createdAt) {
      throw replaceRefused('The new connection must be newer than the one it replaces');
    }
    await applyReplacement(tx, ctx.merchantId, oldId, successorId);
  });
  log('info', 'connection replaced', { connectionId: oldId, replacedBy: successorId });
  return { connection_id: oldId, replaced_by: successorId };
}

// ─── status ──────────────────────────────────────────────────────────────────

/** A dashboard page on the web app (usetendr.tech in production). */
const dashboardHref = (path: string) => new URL(path, env().WEB_URL).toString();

/** Dashboard pages the status items link to. `/dashboard/settings/payout` is added by the web task. */
export const CONNECT_STATUS_PATHS = {
  goLive: '/dashboard',
  payout: '/dashboard/settings/payout',
  secondKey: '/dashboard/onboarding/second-key',
} as const;

const BLOCKING: Record<ConnectBlockingCode, { message: string; path: string }> = {
  live_mode_unavailable: {
    message: liveModeUnavailable().message,
    path: CONNECT_STATUS_PATHS.goLive,
  },
  store_inactive: {
    message: 'Your tendr store is not active. Contact tendr support',
    path: CONNECT_STATUS_PATHS.goLive,
  },
  live_account_missing: {
    message: 'Finish going live on your tendr dashboard',
    path: CONNECT_STATUS_PATHS.goLive,
  },
  live_account_pending: {
    message: 'Your live account is still being set up',
    path: CONNECT_STATUS_PATHS.goLive,
  },
  test_account_pending: {
    message: 'Your test account is still being set up',
    path: CONNECT_STATUS_PATHS.goLive,
  },
  payout_missing: { message: 'Add a payout method', path: CONNECT_STATUS_PATHS.payout },
};

/**
 * Whether the connection can take payments in its key's mode (`GET /v1/connect/status`):
 * - live: the store is active, the live account exists and is active, and payout is set;
 * - test: the test account is active and payout is set (no go-live items).
 * Plus the non-blocking `single_key` nudge when the store's signers hold exactly one passkey.
 */
export async function connectStatus(
  ctx: CheckoutCtx & { connectionId: string },
): Promise<ConnectStatusResponse> {
  // While the live-mode switch is off, a live connection is blocked on that first of all.
  const blocking: ConnectBlockingCode[] =
    ctx.livemode && !liveModeOpen() ? ['live_mode_unavailable'] : [];
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: ctx.merchantId },
    select: { status: true },
  });
  if (merchant.status !== 'active') blocking.push('store_inactive');

  if (ctx.livemode) {
    const { live } = await goLiveStatus(ctx.merchantId);
    if (!live) blocking.push('live_account_missing');
    else if (live.status !== 'active') blocking.push('live_account_pending');
    else {
      const r = await readinessFor(ctx, true);
      if (!r.ready) blocking.push('payout_missing');
    }
  } else {
    const r = await readinessFor(ctx, false);
    if (!r.ready) {
      blocking.push(r.gap === 'payout_missing' ? 'payout_missing' : 'test_account_pending');
    }
  }

  const nudges: ConnectStatusResponse['nudges'] =
    (await signerPasskeyCount(ctx.merchantId)) === 1
      ? [
          {
            code: 'single_key',
            message: "Add a second device or a co-owner so a lost phone can't lock you out",
            href: dashboardHref(CONNECT_STATUS_PATHS.secondKey),
          },
        ]
      : [];

  return {
    connection_id: ctx.connectionId,
    mode: ctx.livemode ? 'live' : 'test',
    ready: blocking.length === 0,
    blocking: blocking.map((code) => ({
      code,
      message: BLOCKING[code].message,
      href: dashboardHref(BLOCKING[code].path),
    })),
    nudges,
  };
}

// ─── disconnect and the dashboard's connected sites ──────────────────────────

/** The site disconnects itself with its connection key: keys and endpoints revoked, domain kept. */
export async function disconnect(connectionId: string): Promise<void> {
  await prisma.$transaction((tx) => revokeConnection(tx, connectionId, 'site'));
}

/** Deletes any credentials still held for the connection's codes (never redeemed). */
async function dropHeldCredentials(tx: Tx, connectionId: string): Promise<void> {
  const held = await tx.connectAuthCode.findMany({
    where: { connectionId, credentialsRef: { not: null } },
    select: { id: true, credentialsRef: true },
  });
  for (const c of held) {
    await tx.connectAuthCode.update({ where: { id: c.id }, data: { credentialsRef: null } });
    await deleteSecret(c.credentialsRef!, tx);
  }
}

/** The store's connected sites (redeemed connections), newest first. */
export async function listConnections(merchantId: string): Promise<ConnectedSite[]> {
  const rows = await prisma.connection.findMany({
    where: { merchantId, redeemedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    include: {
      connectedBy: { select: { id: true, email: true } },
      apiKeys: { select: { lastUsedAt: true } },
    },
  });
  return rows.map((c) => {
    const used = [c.lastUsedAt, ...c.apiKeys.map((k) => k.lastUsedAt)]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    return {
      id: c.id,
      site_url: c.siteUrl,
      platform: c.platform,
      connected_by: { user_id: c.connectedBy.id, email: c.connectedBy.email },
      created_at: c.createdAt.toISOString(),
      last_used_at: used ? used.toISOString() : null,
      status: c.revokedAt ? 'revoked' : 'active',
    };
  });
}

/**
 * Removes a connection from the dashboard (owner/admin with step-up, checked by the route): its
 * keys and endpoints are revoked and the domain rule applies (`revokeConnection(…, 'dashboard')`).
 * A connection of another store is NOT_FOUND.
 */
export async function removeConnection(
  merchantId: string,
  connectionId: string,
): Promise<{ id: string; deleted: true }> {
  await prisma.$transaction(async (tx) => {
    const own = await tx.connection.findFirst({
      where: { id: connectionId, merchantId },
      select: { id: true },
    });
    if (!own) throw notFound('Connection not found');
    await revokeConnection(tx, connectionId, 'dashboard');
    await dropHeldCredentials(tx, connectionId);
  });
  return { id: connectionId, deleted: true };
}

// ─── sweeper ─────────────────────────────────────────────────────────────────

/**
 * Connect housekeeping (worker, every minute):
 * - deletes the held credentials of every code past its expiry that was never used;
 * - revokes every connection still not redeemed `UNREDEEMED_CONNECTION_TTL_MS` after approval.
 *   No site ever received its keys, so the domain rule applies as for a dashboard removal: the
 *   domain is removed (or handed to a live peer) only when this connection added it.
 * Returns the number of connections revoked.
 */
export async function sweepConnections(now = new Date()): Promise<number> {
  const expired = await prisma.connectAuthCode.findMany({
    where: { credentialsRef: { not: null }, usedAt: null, expiresAt: { lte: now } },
    select: { id: true, credentialsRef: true },
    take: 500,
  });
  for (const c of expired) {
    await prisma.$transaction(async (tx) => {
      const cleared = await tx.connectAuthCode.updateMany({
        where: {
          id: c.id,
          credentialsRef: c.credentialsRef,
          usedAt: null,
          expiresAt: { lte: now },
        },
        data: { credentialsRef: null },
      });
      if (cleared.count === 1) await deleteSecret(c.credentialsRef!, tx);
    });
  }

  const staleBefore = new Date(now.getTime() - UNREDEEMED_CONNECTION_TTL_MS);
  const stale = await prisma.connection.findMany({
    where: { redeemedAt: null, revokedAt: null, createdAt: { lte: staleBefore } },
    select: { id: true, merchantId: true },
    take: 500,
  });
  let revoked = 0;
  for (const c of stale) {
    const done = await prisma.$transaction(async (tx) => {
      // Lock order as revokeConnection: the store, then the connection. A redemption racing this
      // one holds the connection row, so re-check once it is ours.
      await tx.$queryRaw`SELECT id FROM merchants WHERE id = ${c.merchantId} FOR UPDATE`;
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM connections
        WHERE id = ${c.id} AND redeemed_at IS NULL AND revoked_at IS NULL
        FOR UPDATE`;
      if (rows.length === 0) return false;
      await revokeConnection(tx, c.id, 'expired');
      await dropHeldCredentials(tx, c.id);
      return true;
    });
    if (done) revoked += 1;
  }
  if (revoked > 0) log('info', 'revoked un-redeemed connections', { count: revoked });
  return revoked;
}
