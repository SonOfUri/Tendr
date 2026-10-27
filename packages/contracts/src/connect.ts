// Connect: linking a site (the WooCommerce plugin) to a store with an authorization-code flow and
// PKCE (WooCommerce plugin spec §2). The code exchange is server to server; the response carries
// the connection's raw keys and webhook signing secrets exactly once.
import { z } from 'zod';
import type { Scope } from './auth.js';

export const ConnectionPlatformValues = ['woocommerce'] as const;
export type ConnectionPlatform = (typeof ConnectionPlatformValues)[number];
export const ConnectionPlatformSchema = z.enum(ConnectionPlatformValues);

/** The scopes of a connection's secret keys (both modes). */
export const CONNECTION_KEY_SCOPES = [
  'sessions:read',
  'sessions:write',
  'payments:read',
  'refunds:write',
  'events:read',
] as const satisfies readonly Scope[];

/** Where a connection's webhook endpoint lives, below the site's home URL. */
export const CONNECT_WEBHOOK_PATH = '/wp-json/tendr/v1/webhook';

/** An authorization code is valid this long after approval, once. */
export const CONNECT_CODE_TTL_MS = 60_000;

/** `POST /v1/connect/token` body. `code_verifier` is the RFC 7636 verifier (43–128 chars). */
export const ConnectTokenRequestSchema = z
  .object({
    code: z.string().min(1).max(200),
    code_verifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    site_url: z.string().min(1).max(2048),
  })
  .strict();
export type ConnectTokenRequest = z.infer<typeof ConnectTokenRequestSchema>;

/** One mode's raw credentials, returned once. */
export const ConnectModeCredentialsSchema = z.object({
  secret_key: z.string(),
  publishable_key: z.string(),
  webhook_secret: z.string(),
});
export type ConnectModeCredentials = z.infer<typeof ConnectModeCredentialsSchema>;

/** `POST /v1/connect/token` response. `*_account` are the store's NEAR account ids. */
export const ConnectTokenResponseSchema = z.object({
  connection_id: z.string(),
  store: z.object({
    id: z.string(),
    name: z.string(),
    test_account: z.string(),
    live_account: z.string().nullable(),
  }),
  test: ConnectModeCredentialsSchema,
  live: ConnectModeCredentialsSchema,
});
export type ConnectTokenResponse = z.infer<typeof ConnectTokenResponseSchema>;

/** A PKCE S256 challenge: base64url (no padding) of a sha256 digest. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * `POST /v1/connect/authorize` body (the approval screen, owner/admin with a fresh passkey).
 * `return_url` must be http(s), on the same origin as `site_url`, with no fragment (checked by the
 * API). `state` is echoed back untouched.
 */
export const ConnectAuthorizeRequestSchema = z
  .object({
    site_url: z.string().min(1).max(2048),
    return_url: z.string().min(1).max(2048),
    state: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, 'printable ASCII without spaces'),
    code_challenge: z.string().regex(S256_CHALLENGE, 'a base64url S256 challenge'),
    code_challenge_method: z.literal('S256'),
    platform: ConnectionPlatformSchema,
    plugin_version: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[0-9A-Za-z.+-]+$/),
  })
  .strict();
export type ConnectAuthorizeRequest = z.infer<typeof ConnectAuthorizeRequestSchema>;

/** `POST /v1/connect/authorize` response: where the popup goes next (`?code=…&state=…`). */
export const ConnectAuthorizeResponseSchema = z.object({ redirect: z.string() });
export type ConnectAuthorizeResponse = z.infer<typeof ConnectAuthorizeResponseSchema>;

/** Why a connection cannot take payments in its key's mode yet (`GET /v1/connect/status`). */
export const ConnectBlockingCodeValues = [
  'store_inactive',
  'live_account_missing',
  'live_account_pending',
  'test_account_pending',
  'payout_missing',
] as const;
export type ConnectBlockingCode = (typeof ConnectBlockingCodeValues)[number];

/** `GET /v1/connect/status` response. `href` is a dashboard page that fixes the item. */
export const ConnectStatusResponseSchema = z.object({
  connection_id: z.string(),
  mode: z.enum(['test', 'live']),
  ready: z.boolean(),
  blocking: z.array(
    z.object({ code: z.enum(ConnectBlockingCodeValues), message: z.string(), href: z.string() }),
  ),
  nudges: z.array(
    z.object({ code: z.literal('single_key'), message: z.string(), href: z.string() }),
  ),
});
export type ConnectStatusResponse = z.infer<typeof ConnectStatusResponseSchema>;

/**
 * `POST /v1/connect/replace` body, authenticated with the OLD connection's key: the site re-connected
 * at a new address and hands its earlier orders to the new connection (spec §2.9). The successor
 * must be a live, redeemed connection of the same store created after the old one.
 */
export const ConnectReplaceRequestSchema = z
  .object({ successor_connection_id: z.string().min(1).max(64) })
  .strict();
export type ConnectReplaceRequest = z.infer<typeof ConnectReplaceRequestSchema>;

/** `POST /v1/connect/replace` response. */
export const ConnectReplaceResponseSchema = z.object({
  connection_id: z.string(),
  replaced_by: z.string(),
});
export type ConnectReplaceResponse = z.infer<typeof ConnectReplaceResponseSchema>;

/** One row of the dashboard's Connected sites (`GET /v1/connections`). */
export const ConnectedSiteSchema = z.object({
  id: z.string(),
  site_url: z.string(),
  platform: ConnectionPlatformSchema,
  connected_by: z.object({ user_id: z.string(), email: z.string() }),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  status: z.enum(['active', 'revoked']),
});
export type ConnectedSite = z.infer<typeof ConnectedSiteSchema>;
