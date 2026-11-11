# Tendr TypeScript SDK

`tendr-sdk` 0.2.0 is a server-side TypeScript/JavaScript client for the hosted Tendr API. It includes ESM and CommonJS entry points, TypeScript declarations, and Node webhook verification, with **zero runtime dependencies**. Requires Node.js 22 or later.

Licensed under MIT.

```sh
npm install tendr-sdk
```

For a release archive supplied directly by Tendr, use `npm install ./tendr-sdk-0.2.0.tgz`.

## Create a checkout

```ts
import { TendrClient } from 'tendr-sdk';

const apiKey = process.env.TENDR_SECRET_KEY;
if (!apiKey) throw new Error('Set TENDR_SECRET_KEY on your server');
const tendr = new TendrClient({ apiKey });

const session = await tendr.checkoutSessions.create(
  {
    amount: '25.00',
    amount_currency: 'USD',
    external_ref: 'order-1042',
    success_url: 'https://shop.example/orders/1042',
    cancel_url: 'https://shop.example/cart',
    line_items: [{ name: 'T-shirt', quantity: 1, unit_amount: '25.00' }],
  },
  { idempotencyKey: 'order-1042-checkout-1' },
);
// Persist session.id and the entire session.url, then redirect the customer to it.
// Preserve #cs=…; do not log the URL or client_secret.
const current = await tendr.checkoutSessions.retrieve(session.id);
```

CommonJS: `const { TendrClient } = require('tendr-sdk');`.

The API key chooses the store and mode: `tdr_test_…` or `tdr_live_…`. A live key does not bypass wallet readiness or platform live-mode checks. Create keys and webhook endpoints in the Tendr dashboard. The client defaults to `https://api.usetendr.tech`; a custom `baseUrl` must be HTTPS (HTTP is allowed for localhost testing). Never bundle secret keys into a browser; the client refuses browser construction. Use the hosted checkout or the separate browser embed for shoppers.

## Methods and permissions

| Resource           | Methods                                                                                                                                            | Secret-key scope                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `ping`             | `ping()` returns store, mode, scopes                                                                                                               | Any secret key                                  |
| `checkoutSessions` | `create`, `retrieve`, `expire`                                                                                                                     | `sessions:write` / `sessions:read`              |
| `refunds`          | `create`, `cancel`                                                                                                                                 | `refunds:write`                                 |
| `paymentLinks`     | `create`, `retrieve`, `list`, `iterate`, `update`, `archive`, `settlementOptions`                                                                  | `payment_links:write` / `payment_links:read`    |
| `themes`           | `presets`, `list`, `iterate`, `create`, `retrieve`, `update`, `delete`, `validate`, `preview`, `publish`, `setDefault`, `fromWebsite`, `fromStore` | `themes:write` / `themes:read`                  |
| `themeAssets`      | `upload`, `list`, `delete`                                                                                                                         | `themes:write` / `themes:read`                  |
| `gasPolicy`        | `retrieve`, `usage`, `update`                                                                                                                      | Reads: any secret key; update: `sessions:write` |
| `gasSponsorships`  | `list`, `iterate`                                                                                                                                  | `payments:read`                                 |
| `hookCalls`        | `list`, `iterate`, `resend(paymentId)`                                                                                                             | `payments:read` / `sessions:write`              |

All methods accept a final request-options argument with `signal` and `timeoutMs`. POST methods also accept `idempotencyKey`. Monetary values stay strings; never convert token base units to JavaScript `number`.

- Session creation returns `{id, url, client_secret, expires_at, status}`. Retrieval/expiry returns the full typed session with payments, refunds, settlement details, network fees and totals, **without** `client_secret`. Its URL has no secret fragment; reuse the saved create URL when reopening checkout.
- `refunds.create` takes exactly one of `session` or `payment`, a decimal `amount`, and `external_ref`. It requests a refund; wallet authorization and execution happen separately. Follow progress in session refunds and signed webhooks. `cancel` only works before a proposal exists.
- `settlementOptions` lists supported assets. A payment-link `settlement_asset` override credits that asset to the same Tendr wallet; it does not supply an external payout address.
- Themes/assets are store-level resources. Publishing/default changes require a live key. Preview input uses `sample`, `scheme` and `viewport`.
- Gas policy updates can change sponsorship spend. Connection keys cannot update the policy or use integrator hooks. Hook resends take a **payment ID**, only retry eligible failed contract calls, and may spend gas.
- Dashboard-only operations (API-key/webhook management, invoices, AI, team, wallet/passkey recovery and signing) are not secret-key SDK methods. Publishable keys and shopper session secrets are not accepted by this client. API keys requiring optional HMAC request signing are not supported by this release.

## Refund and settlement example

```ts
const options = await tendr.paymentLinks.settlementOptions();
const asset = options.tokens.find((token) => token.symbol === 'USDC' && token.chain === 'base');
if (!asset) throw new Error('Choose an asset returned by settlementOptions');
const link = await tendr.paymentLinks.create(
  {
    title: 'Design deposit',
    amount_type: 'fixed',
    amount: '250.00',
    currency: 'USD',
    settlement_asset: asset.asset,
  },
  { idempotencyKey: 'design-deposit-1042' },
);

const refund = await tendr.refunds.create(
  {
    session: session.id,
    amount: '5.00',
    currency: 'USD',
    external_ref: 'refund-1042-1',
  },
  { idempotencyKey: 'refund-1042-1' },
);
```

## Pagination

```ts
const page = await tendr.paymentLinks.list({ status: 'active', limit: 20 });
for await (const link of tendr.paymentLinks.iterate({ status: 'active', limit: 20 })) {
  // Pages are requested lazily. Breaking stops further requests.
  console.log(link.id, link.title);
}
```

The regular list methods preserve the API's page shape. Links/themes use `{data, has_more}`; hooks use `{hook_calls, has_more, next_cursor}`; gas records use `{gas_sponsorships, has_more, next_cursor}`.

## Timeouts, cancellation and retries

```ts
const tendr = new TendrClient({ apiKey, timeoutMs: 15_000 });
await tendr.checkoutSessions.retrieve('ses_example', {
  timeoutMs: 5_000,
  signal: AbortSignal.timeout(4_000),
});
```

There are **no automatic retries or generated idempotency keys**. Persist a key per logical POST operation; retry the same body and key after reconciling an ambiguous result. An aborted/timed-out write may still have completed on the server. POST replay lasts 24 hours and is scoped to the authenticated credential, store and mode. PATCH/PUT/DELETE do not use that replay layer. Multipart boundaries can change between upload calls, so repeating an upload with the same key may produce an idempotency conflict; reconcile the asset list first.

Errors exported from the main package:

- `TendrApiError`: HTTP `status`, API `code`, `requestId`, optional `details`, and raw `retryAfter` header. Future codes are preserved. Non-JSON HTTP failures use `HTTP_ERROR`.
- `TendrTimeoutError`: deadline exceeded, with `timeoutMs`; extends `TendrConnectionError`.
- `TendrConnectionError`: network failure or rejected redirect; write outcome may be unknown.
- `TendrAbortError`: caller cancellation.
- `TendrResponseError`: invalid successful JSON or a non-advancing pagination cursor.

```ts
import { TendrApiError } from 'tendr-sdk';
try {
  await tendr.checkoutSessions.retrieve('ses_example');
} catch (error) {
  if (error instanceof TendrApiError) console.error(error.status, error.code, error.requestId);
  else throw error;
}
```

## Webhooks (Node only)

```ts
import { constructWebhookEvent } from 'tendr-sdk/webhook';

const event = constructWebhookEvent({
  payload: rawBody, // string or Uint8Array/Buffer, BEFORE JSON parsing
  signatureHeader: request.headers.get('tendr-signature') ?? '',
  secret: webhookSigningSecret,
});
```

This verifies the HMAC, enforces a five-minute timestamp tolerance, accepts rotation signatures, then validates the event envelope. Invalid signatures/JSON/envelopes throw `TendrWebhookError`. `verifyWebhookSignature` remains available for boolean-only verification; `signWebhookPayload` creates test fixtures. The `webhook` subpath uses Node crypto and must stay server-side.

Do not fulfill an order from a redirect or popup event. Verify `payment.succeeded`, deduplicate `event.id` durably, retrieve the session, and match the stored order's session/reference, mode, amount and settled payment. Event `data` is intentionally `Record<string, unknown>`: validate fields for the event being handled. See the [framework-neutral webhook example](examples/webhook.ts) and [checkout example](examples/checkout.ts).

## Maintainers

From the repository root:

```sh
npm run generate:types --workspace=tendr-sdk
npm run check:contracts --workspace=tendr-sdk
npm run check:api-types --workspace=tendr-sdk
npm run typecheck --workspace=tendr-sdk
npm run lint --workspace=tendr-sdk
npm run test --workspace=tendr-sdk
npm run test:package --workspace=tendr-sdk
mkdir -p dist/sdk
npm pack --workspace=tendr-sdk --pack-destination ./dist/sdk
```

`prepack` builds both formats. The generated public contract snapshot contains no runtime schema code or private package imports. API serializer checks catch response drift. `test:package` installs the actual tarball in a temporary consumer with no workspace dependencies, executes ESM/CommonJS, and compiles both declaration paths and the examples. CI runs these checks. Publish the verified archive with `npm publish ./dist/sdk/tendr-sdk-0.2.0.tgz --access public --registry=https://registry.npmjs.org`. Publishing requires an npm maintainer account for `tendr-sdk` and npm authentication/2FA. Verify the registry version and install it in a clean project before announcing a release.
