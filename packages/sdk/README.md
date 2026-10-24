# @tendr/sdk

Typed TypeScript client for the Tendr API.

```ts
import { TendrClient } from '@tendr/sdk';

const client = new TendrClient({
  baseUrl: 'http://localhost:4000',
  apiKey: process.env.TENDR_SECRET_KEY, // tdr_test_… or tdr_live_…
});
```

The client handles authentication, `Idempotency-Key` headers, timeouts and typed errors
(`TendrApiError`). Endpoint methods (sessions, quotes, payments) are coming in the checkout
project.

Webhook verification (Node only):

```ts
import { verifyWebhookSignature } from '@tendr/sdk/webhook';
```

Never embed secret API keys in browser bundles.
