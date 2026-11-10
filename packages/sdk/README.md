# @tendr/sdk

Private workspace TypeScript client for Tendr. Build with `npm run build --workspace=@tendr/contracts` and `npm run build --workspace=@tendr/sdk` from the repository root. A public npm release is not assumed.

Implemented resources: `checkoutSessions.create`, `paymentLinks`, `themes`, and `themeAssets`. Authentication, optional idempotency headers, timeouts and typed API errors are supported; retries are caller-managed. Webhook verification is available through the Node-only `@tendr/sdk/webhook` export.

See [the SDK documentation](../../apps/docs/sdks/typescript.mdx) and [HTTP quickstart](../../apps/docs/quickstart.mdx). Keep secret keys server-side.
