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
