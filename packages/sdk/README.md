# @tendr/sdk

Typed TypeScript client for the Tendr API.

```ts
import { TendrClient } from '@tendr/sdk';

const client = new TendrClient({
  baseUrl: 'http://localhost:4000',
  apiKey: process.env.TENDR_API_KEY,
});

const session = await client.createCheckoutSession({
  merchantReference: 'order_123',
  amount: '49.99',
  currency: 'USD',
  successUrl: 'http://localhost:3000/success',
  cancelUrl: 'http://localhost:3000/cancel',
  mode: 'sandbox',
});
```

Webhook verification (Node only):

```ts
import { verifyWebhookSignature } from '@tendr/sdk/webhook';
```

Never embed secret API keys in browser bundles.
