// Connections: sites linked to a store through Connect (WooCommerce plugin spec §2).
//
// A connection owns, per mode, one secret key, one publishable key and one webhook endpoint.
// Ruling W1: a "connection key" is an ordinary `secret_key` principal whose `api_keys` row has
// `connection_id` set; there is no separate principal kind. Raw keys and webhook signing secrets
// are returned exactly once, from `createConnection`: keys are stored as sha256 + display prefix,
// signing secrets only through the KeyVault (`putSecret`).
//
// Connecting adds the site's origin to the store's `checkout_domains` when missing and records
// that it did (`added_domain`). A dashboard removal takes the domain away again only when this
// connection added it and no other live connection is on that origin (otherwise ownership passes
// to that connection); a Disconnect from the site never touches it, and a hand-added domain is
// never removed.
import type { Connection, Prisma } from '@prisma/client';
import {
  CONNECT_WEBHOOK_PATH,
  CONNECTION_KEY_SCOPES,
  MAX_CHECKOUT_DOMAINS,
  type ConnectionPlatform,
  type Scope,
} from '@tendr/contracts';
import { normalizeCheckoutDomain } from '../checkout/checkout-settings.js';
import {
  newWebhookSecret,
  strictHostPolicy,
  validateEndpointUrl,
  WEBHOOK_SECRET_PURPOSE,
} from '../checkout/webhooks.js';
import { assertTransaction, recordEvent } from '../events/record.js';
import { generateApiKey } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { LOCAL_DEV_HOSTS } from '../lib/local-hosts.js';
import { putSecret } from '../secrets/secrets.js';

export { CONNECTION_KEY_SCOPES };

type Tx = Prisma.TransactionClient;

/** Internal audit events (never webhooks): one per mode, so each mode's log shows them. */
export const CONNECTION_CREATED = 'connection.created';
export const CONNECTION_REVOKED = 'connection.revoked';

export type ConnectErrorReason = 'DOMAIN_LIMIT' | 'INVALID_SITE_URL';

const CONNECT_ERRORS: Record<
  ConnectErrorReason,
  { code: 'DOMAIN_LIMIT' | 'VALIDATION_ERROR'; status: number; message: string }
> = {
  DOMAIN_LIMIT: {
    code: 'DOMAIN_LIMIT',
    status: 409,
    message: `This store already has ${MAX_CHECKOUT_DOMAINS} checkout domains. Remove one in Settings before connecting another site.`,
  },
  INVALID_SITE_URL: {
    code: 'VALIDATION_ERROR',
    status: 400,
    message: 'The site URL is not valid',
  },
};

/** A Connect failure; `reason` is the stable machine-readable cause. */
export class ConnectError extends AppError {
  readonly reason: ConnectErrorReason;

  constructor(reason: ConnectErrorReason, message?: string) {
    const e = CONNECT_ERRORS[reason];
    super(
      e.code,
      message ?? e.message,
      e.status,
      reason === 'INVALID_SITE_URL' ? { field: 'site_url' } : undefined,
    );
    this.name = 'ConnectError';
    this.reason = reason;
  }
}

const invalidSite = (why: string) =>
  new ConnectError('INVALID_SITE_URL', `The site URL is not valid: ${why}`);

/**
 * The origin of a site's home URL plus its subdirectory path (no trailing `/`; `''` at the root).
 * The origin follows the checkout-domain rules exactly (`normalizeCheckoutDomain`): `https://`,
 * or `http://localhost` (127.0.0.1, [::1]) outside production. Credentials, queries and
 * fragments are rejected.
 */
export function siteOriginOf(siteUrl: string): { origin: string; path: string } {
  let u: URL;
  try {
    u = new URL(siteUrl.trim());
  } catch {
    throw invalidSite('not a URL');
  }
  if (u.username || u.password) throw invalidSite('credentials are not allowed');
  if (u.search || u.hash) throw invalidSite('a query or fragment is not allowed');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw invalidSite('must use https://');
  }
  const r = normalizeCheckoutDomain(u.origin, process.env.NODE_ENV === 'production');
  if ('error' in r) throw invalidSite(r.error);
  return { origin: r.origin, path: u.pathname.replace(/\/+$/, '') };
}

/** The connection's webhook endpoint URL for a site. */
export function connectionWebhookUrl(site: { origin: string; path: string }): string {
  return `${site.origin}${site.path}${CONNECT_WEBHOOK_PATH}`;
}

export interface ModeCredentials {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

/** Raw credentials, returned once by `createConnection` and never stored raw. */
export interface IssuedCredentials {
  test: ModeCredentials;
  live: ModeCredentials;
}

export interface CreateConnectionInput {
  merchantId: string;
  /** The person approving the connection (an owner or admin; checked by the caller). */
  userId: string;
  siteUrl: string;
  platform: ConnectionPlatform;
}

/** Publishable keys carry no scope: no route needs one yet (least privilege). */
const PUBLISHABLE_KEY_SCOPES: Scope[] = [];

/**
 * The endpoint URL as each mode accepts it, and whether the live endpoint can be active. Checked
 * before anything is written (the live check resolves DNS). A local development site
 * (`http://localhost`, only accepted outside production) cannot receive live webhooks — live
 * endpoints must be https on a public host — so its live endpoint is created inactive.
 */
async function endpointUrls(site: { origin: string; path: string }) {
  const raw = connectionWebhookUrl(site);
  const test = await validateEndpointUrl(raw, false);
  const host = new URL(raw).hostname;
  if (!strictHostPolicy(false) && LOCAL_DEV_HOSTS.has(host)) {
    return { test, live: test, liveActive: false };
  }
  return { test, live: await validateEndpointUrl(raw, true), liveActive: true };
}

/**
 * Creates a connection for `siteUrl` on the store: per mode a secret key (scopes
 * `CONNECTION_KEY_SCOPES`), a publishable key and a webhook endpoint (all events) at
 * `<site>/wp-json/tendr/v1/webhook`, all bound to the connection; and adds the site's origin to
 * `checkout_domains` when missing. Throws `ConnectError('DOMAIN_LIMIT')` when that would exceed
 * `MAX_CHECKOUT_DOMAINS`. Must run in the caller's transaction; everything commits together.
 */
export async function createConnection(
  tx: Tx,
  input: CreateConnectionInput,
): Promise<{ connection: Connection; issued: IssuedCredentials }> {
  assertTransaction(tx);
  const site = siteOriginOf(input.siteUrl);
  const urls = await endpointUrls(site);

  // Serialise checkout-domain changes for the store (as the settings update does).
  const locked = await tx.$queryRaw<{ checkout_domains: string[] }[]>`
    SELECT checkout_domains FROM merchants WHERE id = ${input.merchantId} FOR UPDATE`;
  if (locked.length === 0) throw notFound('Store not found');
  const domains = locked[0]!.checkout_domains;
  const adds = !domains.includes(site.origin);
  if (adds && domains.length >= MAX_CHECKOUT_DOMAINS) throw new ConnectError('DOMAIN_LIMIT');

  const connection = await tx.connection.create({
    data: {
      id: newId('con'),
      merchantId: input.merchantId,
      platform: input.platform,
      siteUrl: input.siteUrl.trim(),
      siteOrigin: site.origin,
      connectedByUserId: input.userId,
      addedDomain: adds ? site.origin : null,
    },
  });
  if (adds) {
    await tx.merchant.update({
      where: { id: input.merchantId },
      data: { checkoutDomains: [...domains, site.origin] },
    });
  }

  const name = `${input.platform} ${site.origin}${site.path}`;
  const issue = async (livemode: boolean): Promise<ModeCredentials> => {
    const ctx = { merchantId: input.merchantId, livemode };
    const keys = [
      { kind: 'secret' as const, scopes: [...CONNECTION_KEY_SCOPES] as Scope[] },
      { kind: 'publishable' as const, scopes: PUBLISHABLE_KEY_SCOPES },
    ].map(({ kind, scopes }) => ({ kind, scopes, key: generateApiKey(kind, livemode) }));
    for (const { kind, scopes, key } of keys) {
      await tx.apiKey.create({
        data: {
          id: newId('key'),
          ...ctx,
          name,
          kind,
          keyPrefix: key.prefix,
          keyHash: key.hash,
          scopes,
          connectionId: connection.id,
        },
      });
    }
    const webhookSecret = newWebhookSecret();
    const secretRef = await putSecret(webhookSecret, WEBHOOK_SECRET_PURPOSE, tx);
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        id: newId('whe'),
        ...ctx,
        url: livemode ? urls.live : urls.test,
        secretRef,
        events: ['*'],
        active: livemode ? urls.liveActive : true,
        connectionId: connection.id,
      },
    });
    await recordEvent(tx, ctx, {
      aggregateType: 'connection',
      aggregateId: connection.id,
      type: CONNECTION_CREATED,
      payload: {
        connection_id: connection.id,
        platform: input.platform,
        site_origin: site.origin,
        user_id: input.userId,
        endpoint_id: endpoint.id,
        added_domain: connection.addedDomain,
      },
    });
    return { secretKey: keys[0]!.key.raw, publishableKey: keys[1]!.key.raw, webhookSecret };
  };

  const test = await issue(false);
  const live = await issue(true);
  return { connection, issued: { test, live } };
}

/**
 * Revokes a connection: sets `revoked_at`, revokes its keys (they fail auth with 401 at once) and
 * deactivates its webhook endpoints (the rows stay for their delivery history).
 *
 * The checkout domain is touched only by a dashboard removal, or by the sweeper revoking a
 * connection that was never redeemed (`'expired'`) (ruling W4; spec §2.7: a Disconnect from the
 * site "does not remove the domain"). When this connection added the domain:
 * - another live connection of the store on that origin → ownership (`added_domain`) passes to
 *   it, so the domain keeps an owner;
 * - none → the domain is removed from `checkout_domains`.
 * Either way this connection's `added_domain` is cleared, so the rule runs once. A dashboard
 * removal of a connection the site already disconnected still applies it.
 *
 * Idempotent. Must run in the caller's transaction; the caller has checked that the connection
 * belongs to its store.
 */
export async function revokeConnection(
  tx: Tx,
  connectionId: string,
  by: 'site' | 'dashboard' | 'expired',
): Promise<void> {
  assertTransaction(tx);
  const found = await tx.connection.findUnique({
    where: { id: connectionId },
    select: { merchantId: true },
  });
  if (!found) throw notFound('Connection not found');
  // Same lock order as createConnection: the store first, then the connection.
  const locked = await tx.$queryRaw<{ checkout_domains: string[] }[]>`
    SELECT checkout_domains FROM merchants WHERE id = ${found.merchantId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM connections WHERE id = ${connectionId} FOR UPDATE`;
  const connection = await tx.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const merchantId = connection.merchantId;

  const revoking = connection.revokedAt === null;
  if (revoking) {
    const now = new Date();
    await tx.connection.update({ where: { id: connectionId }, data: { revokedAt: now } });
    await tx.apiKey.updateMany({
      where: { merchantId, connectionId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.webhookEndpoint.updateMany({
      where: { merchantId, connectionId, active: true },
      data: { active: false },
    });
  }

  let removedDomain: string | null = null;
  let domainOwner: string | null = null;
  const domain = connection.addedDomain;
  if (by !== 'site' && domain) {
    const peer = await tx.connection.findFirst({
      where: { merchantId, siteOrigin: domain, revokedAt: null, id: { not: connectionId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    await tx.connection.update({ where: { id: connectionId }, data: { addedDomain: null } });
    if (peer) {
      domainOwner = peer.id;
      await tx.connection.update({ where: { id: peer.id }, data: { addedDomain: domain } });
    } else {
      const domains = locked[0]?.checkout_domains ?? [];
      if (domains.includes(domain)) {
        removedDomain = domain;
        await tx.merchant.update({
          where: { id: merchantId },
          data: { checkoutDomains: domains.filter((d) => d !== domain) },
        });
      }
    }
  }

  if (!revoking && removedDomain === null && domainOwner === null) return; // nothing changed
  for (const livemode of [false, true]) {
    await recordEvent(
      tx,
      { merchantId, livemode },
      {
        aggregateType: 'connection',
        aggregateId: connectionId,
        type: CONNECTION_REVOKED,
        payload: {
          connection_id: connectionId,
          by,
          removed_domain: removedDomain,
          domain_owner: domainOwner,
        },
      },
    );
  }
}
