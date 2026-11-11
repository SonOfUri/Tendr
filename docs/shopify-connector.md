# Shopify connector pilot

This is a **single-store offsite payments connector** in `apps/shopify`, plus a local Docker
simulator. Shopify hosts the actual store. The simulator creates no Shopify account/store,
uses no external provider and cannot move real funds. An approved Shopify store installation
and end-to-end provider testing are still required before using this connector with shoppers.

The implementation follows Shopify's [offsite payments protocol](https://shopify.dev/docs/apps/build/payments/offsite/use-the-cli?framework=remix).
The UI uses React Router 7 framework mode (the maintained successor to Remix 2's framework
APIs), Express and the Shopify API SDK. The tutorial's older Remix dependencies were not
retained because of reported security issues. See the [migration reference](https://reactrouter.com/7.18.0/upgrading/remix).

## Hosted Shopify development store

Created on 7 November 2026 with Shopify CLI, separately from the local simulator:

| Item         | Value                                                  |
| ------------ | ------------------------------------------------------ |
| Name         | Tendr Integration Test                                 |
| Storefront   | https://tendr-integration-test.myshopify.com           |
| Admin        | https://admin.shopify.com/store/tendr-integration-test |
| Store type   | `dev`, verified using `shopify store list --type dev`  |
| Features     | Basic plan features in a free development store        |
| Initial data | Shopify's generated demo data (`--demo-data`)          |

Shopify's [demo-data preset](https://shopify.dev/docs/apps/build/stores/generated-test-data)
includes sample products, collections, customers, draft orders and the Bogus payment gateway
for test orders. This is an actual Shopify storefront and admin. Tendr is not yet installed as a
checkout payment option; that still needs the approved payments extension and mTLS hosting
covered below. No real transaction has been tested on this store.

The storefront was checked and responds successfully at its password-protected page. Sign in
to the store admin, then open the storefront. To share access, view or set a separate storefront
password under **Online Store → Preferences → Password protection**. Shopify requires password
protection on dev stores; see [development-store access](https://shopify.dev/docs/storefronts/themes/tools/development-stores).

## Registered app and current payment-access blocker

The **Tendr Payments** app was registered on 7 November 2026 in the same Shopify organization
as the development store. Its linked CLI project is saved locally at
`.keyvault/shopify-registration/tendr-payments`; the generated `shopify.app.toml` contains the
registered app's client ID. That local registration project is separate from the connector
implementation in `apps/shopify` and is ignored by Git.

The current organization's extension picker returns no result for **Offsite**. A CLI generation
attempt also lists no payments-provider extension among the supported types. The payment
extension has therefore not been generated, deployed or installed, and **Pay with Tendr** is
not an available checkout option. The shopper checkout currently shows Shopify's **Test
Payment Gateway**.

Shopify's [approval process](https://shopify.dev/docs/apps/build/payments/payments-extension-review)
requires Payments Partner access before building a payments extension. Use an already-approved
organization if one exists, or submit the [Payments Platform Application](https://www.shopify.com/paymentsplatformapplication).
Registering an ordinary app and creating a dev store do not grant that capability. Once access
is granted, link the registered app to the connector, generate the Offsite extension, configure
its authenticated endpoints, and complete the dev-store installation/testing steps below.

## Run locally

From the repository root, with Docker running:

```sh
npm run dev:shopify
```

Open **http://localhost:3355**. The launcher generates a random storage encryption key in
`.keyvault/shopify-simulator/docker.env` (ignored by Git, file permission 0600). It builds the
app and starts one container with a persistent SQLite volume. The port is bound to loopback.
No existing Tendr, WooCommerce, Railway or wallet credentials are loaded.

1. Create a test order (default $1).
2. Select **Simulate payment**. The simulated Tendr provider changes state and signs an event.
3. The connector reads the provider's session, checks the order's amount/currency/mode/reference,
   then sends the simulated Shopify resolution. **Return to store** shows the result.
4. Return to the connector and request a full or partial refund.
5. Observe **Awaiting Tendr wallet approval**. Select **Simulate wallet approval** to complete it.
6. Create another order and select **Simulate expiry** to exercise rejection.

```sh
npm run dev:shopify -- stop
npm run dev:shopify -- logs
```

Restarting preserves operations, fixtures and decisions. Keep the encryption key and volume
together. Do not delete the volume or change its key to fix a pending operation. The simulator
is deliberately inaccessible from a public host and rejects real provider credentials.
It tests connector behavior, not Shopify acceptance or on-chain settlement.

## What is implemented

| Endpoint / component                 | Behavior                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `POST /payments/session`             | mTLS-authenticated Shopify sale request → Tendr checkout → stable redirect     |
| `POST /refunds/session`              | mTLS-authenticated request → Tendr merchant refund; no wallet signing          |
| `POST /webhooks/tendr/test` / `live` | Raw-body HMAC and timestamp validation; wakes API reconciliation               |
| `GET /checkout/:token`               | Opaque checkout redirect; completed operations return to their status page     |
| `GET /return/:token`                 | Read-only status; never marks paid because a buyer returned                    |
| `/auth`, `/auth/callback`            | SDK-verified OAuth for the configured permanent Shopify shop domain            |
| `GET/POST /app`                      | Authenticated operator view and explicit gateway enable/disable                |
| `POST /webhooks/shopify/uninstalled` | Verified uninstall removes OAuth/admin credentials and pauses processing       |
| Reconciliation worker                | Durable provider checks, GraphQL retries and recovery when a webhook is missed |

A payment is resolved only after authenticated Tendr session data reports settlement, including
a settled non-late payment. `PROCESSING`, held/screening/late states and signed success events
alone do not qualify. Conversion checks compare the original currency/amount when present.
An expired session with any payment attached stays pending for review. It is not rejected
blindly. Refunds resolve only at Tendr's `merchant_status: sent`; review/retryable failures stay
pending, and a confirmed cancellation rejects the Shopify refund.

Shopify GraphQL responses must contain the expected session ID and terminal state with no
transport, top-level GraphQL or `userErrors` failure. The connector persists the chosen terminal
decision before sending it, retries that decision and never switches it on an ambiguous response.

SQLite stores encrypted operation payloads, checkout URL secrets and offline OAuth tokens.
Bearer return tokens are hashed in the lookup index.
Per-operation leases serialize duplicate requests. IDs are scoped by shop, mode and operation
kind; a changed immutable payload returns 409. The same exact create body and idempotency key
are replayed after a lost response. Unknown creates older than 20 hours stop for manual
reconciliation, before Tendr's 24-hour idempotency window. Changing the Tendr API key during an
uncertain create also stops replay because backend idempotency is credential scoped.

## Connect an approved Shopify dev store

Shopify's [guide requirements](https://shopify.dev/docs/apps/build/payments/offsite/use-the-cli?framework=remix)
include a Partner account, a dev store, and Payments Partner approval. A normal Shopify app or
a dev store alone does not unlock payment extension testing. This repository does not create
or bypass that approval. No Shopify account changes have been made by the local launcher.

After access is available:

1. Register the Shopify app and obtain its client ID and client secret. Use Shopify CLI to link
   the app and generate an **Offsite payments** extension. Retain Shopify's assigned extension
   UID. The two `.toml.example` files under `apps/shopify` are configuration references, not
   registered apps. Fill in the actual host, approved countries and approved payment-method
   identifiers; no card capabilities or unapproved countries are claimed by default.
2. Initially omit the restricted Payments API scopes when deploying the extension, as Shopify's
   guide requires. Once granted, set the app's scopes to
   `write_payment_gateways,write_payment_sessions`, deploy the updated configuration, then install.
   Configure the exact OAuth redirect `/auth/callback` and uninstall webhook from the example.
3. Host the connector with native HTTPS/mTLS using the server settings below. Both payment
   endpoint URLs must match the host in the extension. Pin request/GraphQL API version to
   `2026-10`, which this server validates. Deploying extension configuration does not host this server.
4. Create **dedicated Tendr secret API keys for this store**, with `sessions:read`,
   `sessions:write`, `refunds:write` scopes. Use the correct test/live store accounts and settlement
   settings. This pilot does not use WooCommerce Connect or add Shopify to `/v1/connections`.
5. In each enabled Tendr mode, add a webhook endpoint at `/webhooks/tendr/test` or `/live`.
   Subscribe to `payment.succeeded`, `checkout.session.expired`, `refund.pending`, `refund.sent`,
   `refund.needs_address`, `refund.cancelled`, `refund.failed` (all checkout events are also fine).
   Store each endpoint's signing secret alongside that mode's API key, never in chat or Git.
6. Fill a private env file from `apps/shopify/config.example`. Generate the storage key with
   `openssl rand -hex 32` directly into the private file/secret manager. Keep `SHOPIFY_TEST_ONLY=true`
   for dev-store validation. Starting the real connector requires test credentials and TLS files.
7. Open `https://YOUR_CONNECTOR_HOST/auth?shop=YOUR_STORE.myshopify.com`, approve the requested
   permissions, and use the app's **Enable gateway in Shopify** action. Install/activate the
   extension in Shopify's payment settings and select its **test mode**. Incoming `test:false`
   requests remain rejected while `SHOPIFY_TEST_ONLY=true`.
8. Complete a real Shopify test checkout and refund, including duplicate delivery, a declined or
   expired checkout, uninstall/reinstall and a process restart. Check order status in Shopify and
   authoritative Tendr session/refund status. These account-dependent checks are still outstanding.

To enable real payments later, set `SHOPIFY_TEST_ONLY=false`, supply both live Tendr credentials,
confirm that store's live wallet/payout readiness and complete the approved rollout. There is
no fallback between test and live credentials. Refunds require the wallet owner's normal Tendr
passkey approval; the connector never owns or signs with their wallet key.

## Hosting and mTLS

The provided Compose file is **local simulator configuration only**. The Docker image also runs
the real connector when given private real-mode environment variables and certificate mounts.
Use one process/replica, a persistent volume at `SHOPIFY_DATABASE`, and a stable encryption key.
Do not expose the SQLite file, its backups, or development tooling publicly. The database is
bound to its original shop, simulator/real environment, Tendr API origin and connector origin;
changing those requires a planned migration after reconciling existing operations.

Shopify's [payment security requirements](https://shopify.dev/docs/apps/build/payments/considerations)
require client certificate authentication on payment/refund requests. This server presents a
publicly trusted server certificate and validates Shopify's client certificate against Shopify's
current client CA. Obtain that CA from Shopify's documentation and track rotation/expiry.
Do not substitute Shopify's client certificate for your server certificate.

TLS must reach Node intact: expose its HTTPS port directly or use TCP passthrough. A normal
Railway HTTPS ingress or HTTP tunnel terminates client TLS and is insufficient for this native
mTLS implementation. Forwarded certificate headers are deliberately ignored. Public OAuth,
buyer-return and HMAC webhook endpoints may connect without a client certificate; the financial
session endpoints require an authorized TLS socket and the configured shop/version headers.

`SHOPIFY_TLS_KEY`, `SHOPIFY_TLS_CERT`, `SHOPIFY_CLIENT_CA` are read-only PEM paths. Mount them and
the database into a separately configured container; map the server's HTTPS port appropriately.
Keep request logging off for OAuth query strings, bearer checkout URLs and raw webhook bodies.

## Operations and limitations

- One Shopify store maps to one manually configured Tendr store. Multi-merchant onboarding,
  hosted Shopify Connect, dashboard integration and app review/distribution are separate work.
- Offsite `sale` and refunds only. Manual authorization/capture/void, 3DS, installments, deferred
  payments and inventory-confirmation callbacks are not advertised or implemented.
- Wallet approval can take time. Operators must monitor pending refunds and held payments and
  handle Shopify's resolution deadlines; this pilot does not automate escalation/notifications.
- The return page only links to trusted Shopify redirect hosts from an acknowledged GraphQL
  result. Custom checkout-domain return links need an explicit allowlist extension and testing.
- The worker polls durable pending records and also reacts to verified events. Shopify or Tendr
  outages remain pending. The operator screen marks failed provider checks; it never offers a
  browser action to declare a real payment successful.
- `Needs reconciliation` means stop and inspect the Tendr session/refund by external reference
  and the corresponding Shopify session. Preserve the record and database. Do not generate a
  new Shopify ID, delete the operation, rotate credentials or replay an expired create to force it
  through. Recovery requires a verified operator repair; there is intentionally no “mark paid” UI.
- Back up SQLite consistently (including WAL state, or with SQLite's backup facility) and keep
  the encryption key separately. Never run two independent databases for the same shop.
- OAuth tokens are offline and encrypted. An expired/revoked token requires reauthorization;
  signed uninstall disables processing. Configure webhook/privacy obligations required by Shopify
  during approval; no customer contact/address/card data is retained by this pilot.

## Developer checks

```sh
npm ci --include=dev
npm run build --workspace=@tendr/contracts
npm run build --workspace=@usetendr/sdk
npm run test --workspace=@tendr/shopify
npm run lint --workspace=@tendr/shopify
npm run build --workspace=@tendr/shopify
# With the local Docker simulator running and Chrome installed:
npm run test:e2e --workspace=@tendr/shopify
```

Tests use temporary SQLite databases and local TLS certificate fixtures (OpenSSL required).
They cover concurrency, lost responses, immutable requests, key rotation, restart recovery,
amount/mode/reference corroboration, signature expiry, refund approval, GraphQL errors, native
mTLS and verified uninstall. The simulator browser flow exercises UI → providers → signed event
→ reconciliation → return to store. Neither is evidence of Shopify approval or live-store acceptance.

The production image excludes build/test tooling. Its dependency audit still reports the shared
`@tendr/contracts` Zod 3 dependency's [collection-size advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The connector validates requests with Zod 4.6.7; the SDK runtime used here imports no contracts
validators. Migrating the shared contracts package is separate repository work, so this pilot
does not claim a clean audit for the entire dependency tree.
