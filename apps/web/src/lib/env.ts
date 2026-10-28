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
  /**
   * Tendr's EVM payment forwarder (same address on every EVM chain): the only spender a gasless
   * `permit` may approve. Must equal the API's EVM_FORWARDER_ADDRESS.
   */
  evmForwarderAddress:
    process.env.NEXT_PUBLIC_EVM_FORWARDER_ADDRESS || '0x19BEBC71495490A99cA6F50F107076967380cf09',
  /** Tendr's Tron forwarder (base58); unset turns gasless Tron payments off in the page. */
  tronForwarderAddress: process.env.NEXT_PUBLIC_TRON_FORWARDER_ADDRESS || null,
  /**
   * End-to-end tests only: EVM wallets come from an injected `window.ethereum` (Playwright's test
   * wallet) instead of Reown AppKit. Never set in a deployed build.
   */
  e2eInjectedWallet: process.env.NEXT_PUBLIC_E2E_INJECTED_WALLET === '1',
};

/** Server-only config. */
export function serverEnv() {
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? publicEnv.apiBaseUrl,
    webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
  };
}
