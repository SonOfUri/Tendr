function parseRecipients(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

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
  e2eInjectedWallet:
    process.env.NEXT_PUBLIC_E2E_INJECTED_WALLET === '1' && process.env.NODE_ENV !== 'production',
  /**
   * Tendr's gas-fee accounts per chain (ruling T10-g), JSON `{ "base": "0x…", "sol": "…" }`: every
   * shopper-paid fee leg must go exactly there, and the API's `fee_recipient` must agree. Live
   * gasless payments need the chain pinned; test mode falls back to the API's value.
   */
  gasFeeRecipients: parseRecipients(process.env.NEXT_PUBLIC_GAS_FEE_RECIPIENTS),
};

/** The API's minimum for WEB_INTERNAL_TOKEN (apps/api/src/env.ts): a shorter one is refused there. */
const WEB_INTERNAL_TOKEN_MIN = 32;

/**
 * Why WEB_INTERNAL_TOKEN cannot be used, or null. Required (≥ 32 characters) in production, like
 * the API; elsewhere it may be unset, but a set one is never shorter than the API accepts.
 */
export function webInternalTokenProblem(
  token: string | undefined,
  production: boolean,
): string | null {
  if (!token) {
    return production
      ? 'WEB_INTERNAL_TOKEN is required in production (the payment link page reads the API with it)'
      : null;
  }
  return token.length < WEB_INTERNAL_TOKEN_MIN
    ? `WEB_INTERNAL_TOKEN must be at least ${WEB_INTERNAL_TOKEN_MIN} characters`
    : null;
}

/**
 * Throws on server config a running server cannot use: called at boot (instrumentation.ts) and on
 * every `serverEnv()`. Skipped while `next build` runs, which serves no requests.
 */
export function assertServerEnv(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const problem = webInternalTokenProblem(
    process.env.WEB_INTERNAL_TOKEN,
    process.env.NODE_ENV === 'production',
  );
  if (problem) throw new Error(`Invalid web server config: ${problem}`);
}

/** Server-only config. */
export function serverEnv() {
  assertServerEnv();
  return {
    apiBaseUrl: process.env.API_BASE_URL ?? publicEnv.apiBaseUrl,
    webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
    /**
     * Origin of payment-link addresses, no trailing slash: the API's CHECKOUT_BASE_URL (what its
     * `url` / `qr_url` use), falling back to WEB_URL when unset. The QR code and preview tags
     * must name exactly the address the API reports.
     */
    linkBaseUrl: (
      process.env.CHECKOUT_BASE_URL ||
      process.env.WEB_URL ||
      'http://localhost:3000'
    ).replace(/\/+$/, ''),
    /** Demo Merchant secret test key from seed — never expose to the browser. */
    tendrSecretKeyTest: process.env.TENDR_SECRET_KEY_TEST ?? '',
    /**
     * Shared secret sent as `x-tendr-internal` on the server's payment-link reads, so the API
     * trusts the payer IP it forwards (lib/payment-links.ts). Same value as the API's. Unset: the
     * API keys its limits on this server's address. Never expose to the browser.
     */
    webInternalToken: process.env.WEB_INTERNAL_TOKEN || null,
  };
}
