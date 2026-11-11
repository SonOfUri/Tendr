import routes from './routes.json';
import type { ConsoleAuth } from './request';

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  group: string;
  source: string;
  line: number;
  principals: string[];
  permission?: string;
  scope?: string;
  stepUp?: boolean;
}
export const endpoints: Endpoint[] = routes;

/** Public login responses set cookies, so those calls still need credentials: include. */
export function defaultAuth(endpoint: Endpoint): ConsoleAuth {
  if (
    endpoint.path.startsWith('/v1/auth/') ||
    endpoint.principals.some((p) => ['user_session', 'dashboard_user'].includes(p))
  )
    return 'session';
  return endpoint.principals.includes('public') ? 'public' : 'bearer';
}
export function needsStore(endpoint: Endpoint): boolean {
  return (
    endpoint.principals.includes('dashboard_user') && !endpoint.principals.includes('user_session')
  );
}

const examples: Record<string, unknown> = {
  'POST /v1/account/native/keys/operations': { kind: 'add_passkey', label: 'Backup device' },
  'POST /v1/account/native/keys/operations/:id/register': { response: {} },
  'POST /v1/account/native/keys/operations/:id/prove': { response: {} },
  'POST /v1/account/native/keys/operations/:id/submit': { response: {} },
  'POST /v1/auth/login-recovery/start': { email: 'your-email@example.com' },
  'POST /v1/auth/login-recovery/options': {
    token: 'paste-token-from-email-fragment',
    recoveryCode: 'paste-one-saved-code',
  },
  'POST /v1/auth/login-recovery/verify': {
    token: 'paste-token-from-email-fragment',
    recoveryCode: 'paste-one-saved-code',
    response: {},
  },
  'POST /v1/api_keys': {
    name: 'My backend',
    scopes: ['sessions:read', 'sessions:write', 'payments:read', 'events:read'],
  },
  'POST /v1/account/native/passkey/verify': { response: {} },
  'POST /v1/account/native/activate': { response: {} },
  'PUT /v1/account/native/settlement': { asset: 'copy-an-asset-from-settlement-options' },
  'POST /v1/account/native/payouts': {
    asset: 'copy-an-asset-from-balances',
    amount: '1000000',
    destinationAsset: 'copy-a-destination-asset-from-settlement-options',
    destination: 'paste-the-destination-address',
  },
  'POST /v1/account/native/payouts/:id/submit': { response: {} },
  'POST /v1/auth/email/start': { email: 'tester@example.com' },
  'POST /v1/auth/email/verify': { token: 'paste-token-from-verification-email' },
  'POST /v1/merchants': { name: 'API test store' },
  'POST /v1/account/recovery-key': { publicKey: 'paste-recovery-public-key' },
  'POST /v1/team/invites': { email: 'teammate@example.com', role: 'finance' },
  'PATCH /v1/team/:membershipId': { role: 'finance' },
  'POST /v1/invites/accept': { token: 'paste-invite-token' },
  'POST /v1/account/proposals': {
    action: { add_saved_address: { id: '', chain: 'near', address: 'your-test-account.testnet' } },
  },
  'POST /v1/account/proposals/:id/challenge': { intent: 'approve' },
  'POST /v1/account/proposals/:id/approve': { response: {} },
  'POST /v1/account/recovery/cancel': { response: {} },
  'POST /v1/auth/recovery-session/options': {
    merchant: 'your-store-slug',
    email: 'tester@example.com',
  },
  'POST /v1/auth/recovery-session/verify': {
    merchant: 'your-store-slug',
    email: 'tester@example.com',
    challenge: '',
    signature: '',
  },
  'POST /v1/checkout/sessions': {
    amount: '5.00',
    amount_currency: 'USD',
    external_ref: 'api-test-order-1',
    success_url: 'http://localhost:3000/dashboard',
    cancel_url: 'http://localhost:3000/settings/api-console',
  },
  'POST /v1/checkout/client/quote': { origin_asset: 'copy-an-asset-id-from-the-tokens-response' },
  'POST /v1/checkout/client/ai/assistant': {
    question: 'Has my payment completed? What happens next?',
  },
  'POST /v1/ai/insights': { days: 30, question: 'Summarize conversion and checkout drop-offs.' },
  'POST /v1/ai/themes': {
    name: 'Midnight draft',
    prompt: 'A dark checkout with violet accents, rounded corners and clear typography.',
  },
  'POST /v1/checkout/client/ai/recommendations': {
    assets: [{ asset_id: 'copy-an-asset-id-from-the-tokens-response' }],
  },
  'POST /v1/checkout/client/deposit': { quote_id: 'quo_...', tx_hash: 'paste-transaction-hash' },
  'POST /v1/checkout/client/email': { email: 'shopper@example.com' },
  'POST /v1/checkout/client/simulate': { scenario: 'exact' },
  'POST /v1/checkout/client/gasless/options': {
    origin_asset: 'copy-an-asset-id-from-the-tokens-response',
    wallet_address: 'your-wallet-address',
  },
  'POST /v1/checkout/client/gasless/prepare': { quote_id: 'quo_...' },
  'POST /v1/checkout/client/gasless/submit': { quote_id: 'quo_...', signatures: {} },
  'POST /v1/paymaster/:token': {
    jsonrpc: '2.0',
    id: 1,
    method: 'pm_getPaymasterStubData',
    params: [],
  },
  'POST /v1/payment_links': {
    title: 'API test payment',
    amount_type: 'fixed',
    amount: '5.00',
    currency: 'USD',
  },
  'PATCH /v1/payment_links/:id': { title: 'Updated test payment' },
  'POST /v1/payment_links/public/:merchant/:link/sessions': {},
  'POST /v1/refunds': { payment: 'pay_...', amount: '1.00', external_ref: 'api-test-refund-1' },
  'POST /v1/review/:paymentId/refund': { refund_id: 'ref_...' },
  'PATCH /v1/settings/checkout': { default_fee_payer: 'merchant', default_gas_payer: 'shopper' },
  'POST /v1/settings/notification-email/verify': { token: 'paste-token-from-verification-email' },
  'POST /v1/webhooks/endpoints': { url: 'https://your-test-server.example/webhooks' },
  'POST /v1/themes': { name: 'API test theme', from: 'blank' },
  'PATCH /v1/themes/:id': { name: 'Updated test theme' },
  'POST /v1/themes/:id/preview': { sample: 'checkout', scheme: 'light', viewport: 'phone' },
  'POST /v1/themes/validate': { document: {} },
  'POST /v1/themes/from-website': { url: 'https://your-test-site.example' },
  'POST /v1/themes/from-store': { connection_id: 'con_...' },
};

export function exampleBody(endpoint: Endpoint): string {
  if (['GET', 'HEAD', 'OPTIONS'].includes(endpoint.method)) return '';
  if (endpoint.path.includes('/passkeys/') && endpoint.path.endsWith('/verify'))
    return '{\n  "response": {}\n}';
  return JSON.stringify(examples[endpoint.id] ?? {}, null, 2);
}

export function endpointNote(endpoint: Endpoint): string {
  if (endpoint.path.startsWith('/v1/auth/login-recovery/'))
    return 'Personal login recovery, independent of Test/Live and wallet recovery. Use /settings/login-recovery to save codes with a recent login passkey confirmation, or /recover/login after losing all login passkeys. Recovery needs a fresh email link and one saved code, then a real WebAuthn registration. Completing it revokes all old login keys and sessions. Avoid putting real codes or email tokens into console history; use the dedicated screens.';
  if (endpoint.path.startsWith('/v1/account/native/'))
    return 'Live wallet APIs use a dedicated wallet passkey and the designated owner session with step-up. Register, then activate; payout quotes must be reviewed before signing. For refunds, create a payout with { "proposalId": "prop_..." }. Local simulated mode keeps live writes disabled.';
  if (endpoint.path.startsWith('/v1/connect/') || endpoint.path === '/v1/connection/brand')
    return 'Connect status/disconnect/replace and connection brand need a connected-site key. Authorize/token use the real PKCE flow; inspect the route contract for required fields.';
  if (endpoint.group === 'recovery')
    return 'Recovery start and recovery-session verification need a real recovery-kit signature. Use the existing recovery screen to generate that payload; the JSON editor can replay it. Recovery is not a passkey login.';
  if (endpoint.path.startsWith('/v1/themes'))
    return 'Themes are shared across test and live. Publish/default affect the published theme and may require step-up. Validate/save return normalized documents.';
  if (endpoint.path === '/v1/theme-assets')
    return 'Uploads use kind (logo, image, font) and one file. Public asset serving requires ASSET_PUBLIC_PROXY on the API.';
  if (
    endpoint.path.startsWith('/v1/checkout/client/gasless') ||
    endpoint.path.startsWith('/v1/paymaster')
  )
    return 'Prepare returns the payload a wallet must sign. Supply the genuine wallet signature/transaction to submit; this console does not sign wallet transactions.';
  if (endpoint.path.startsWith('/v1/checkout/client'))
    return 'Use the checkout session client secret, not a merchant API key. Test simulations require a test-mode session and an existing quote. Shopper endpoints require the checkout origin in CORS.';
  if (endpoint.group === 'refunds')
    return 'These endpoints require a secret API key. Dashboard sessions use the review routes instead.';
  if (endpoint.group === 'review')
    return 'Held funds cannot be released into settlement. Returns and legal acknowledgement retain their role, step-up, and signer checks.';
  if (endpoint.path.startsWith('/v1/payment_links'))
    return 'Create a link (session auth), open the returned url on this same origin for the shopper pay page, then POST …/sessions to start checkout. Settlement asset must be active for the store/mode. Public routes need no merchant key.';
  return 'Examples are editable starting points. Replace IDs and placeholders with values from your test data. The API response is authoritative for validation and permissions.';
}
