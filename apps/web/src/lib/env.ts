/**
 * Public/client-safe config only. Never put secrets in NEXT_PUBLIC_*.
 *
 * Each variable is read with a literal `process.env.NEXT_PUBLIC_…` so Next inlines it into the
 * browser bundle (a computed `process.env[name]` is not inlined and is undefined client-side).
 */
export const publicEnv = {
  apiBaseUrl: (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000').replace(/\/+$/, ''),
  /** WebAuthn RP ID for signing ceremonies; unset means the page's own host (local dev). */
  webauthnRpId: process.env.NEXT_PUBLIC_WEBAUTHN_RP_ID || undefined,
  /** Reown (WalletConnect) project id for checkout wallets; unset hides EVM, Solana and Bitcoin. */
  reownProjectId: process.env.NEXT_PUBLIC_REOWN_PROJECT_ID || null,
};

/** Server-only config. */
export function serverEnv() {
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? publicEnv.apiBaseUrl,
    webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  };
}
