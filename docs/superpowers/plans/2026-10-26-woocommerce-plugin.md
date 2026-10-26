# WooCommerce Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "tendr: Pay with crypto" WooCommerce plugin. A store owner connects it in one click, with no key copying, takes crypto payments through the Tendr modal, and has WooCommerce orders driven by signed webhooks.

**Architecture:** The API gains several pieces:
- per-site **connections** issued through an authorization-code + PKCE flow;
- webhook delivery scoped to a connection;
- conversion of non-USD amounts to USD at session creation;
- a merchant refund route that drafts signer proposals;
- a `notification_email` setting with a "You got paid" email.

The web app gains:
- the `/connect` popup;
- a dashboard "Connected sites" page;
- the download page and update feed.

The plugin is self-contained PHP in `apps/woocommerce`. It talks only to the API, and is tested with PHPUnit and wp-env (Docker).

**Tech Stack:**
- Existing: Node 22, TypeScript ESM, Fastify 5, Prisma 6, Postgres 16, Redis, BullMQ, Vitest, Next.js 15, Playwright.
- New: PHP 8.0+, WordPress 6.4+, WooCommerce 8.5+, `@wordpress/env` (Docker), PHPUnit, WooCommerce Blocks payment-method integration, libsodium (`sodium_crypto_secretbox`).

**Spec:** `docs/superpowers/specs/2026-10-26-woocommerce-plugin-design.md`. Read it with this plan; section numbers below (§N) refer to it.

## Global Constraints

- **Domain:** `usetendr.tech` everywhere. `usetendr.xyz` is never used.
- **No secrets shown:**
  - the store owner never copies or sees a secret key;
  - secrets are never sent to the browser;
  - Postgres never stores plaintext secrets: keys are sha256-hashed, and signing secrets go through KeyVault `putSecret`, as today.
- **Webhook truth:** an order becomes paid only on a verified, signed webhook, re-read from the API. The browser never marks it paid.
- **Refunds:** a refund clicked in WooCommerce never moves funds by itself. It always becomes a signer-approved proposal.
- **Isolation:** a connection's webhook endpoints receive only events for sessions and payments created with that connection's keys.
- **Test mode:** the payment method is visible only to users with `manage_woocommerce`.
- **FX:** rates are cached 60 s. A rate older than 10 minutes, or a provider error, returns `FX_RATE_UNAVAILABLE` (503). The USD amount is rounded **up** to the cent.
- **Go live:** project 2's rule is unchanged (signers + recovery key ≥ 2). The `single_key` nudge is non-blocking.
- **Plugin:** licence GPL-2.0-or-later. No runtime dependencies beyond WordPress and WooCommerce. No tracking. Text domain `tendr`. WordPress 6.4+, WooCommerce 8.5+, PHP 8.0+. Declares HPOS compatibility. Supports both the Blocks checkout and the classic checkout.
- **Environment:**
  - Postgres on 5433 (`tendr_foundation`, `tendr_foundation_test`); apply every migration to both. Never touch a DB named `tendr`.
  - Redis on 6380.
  - Do not install software on the host. PHP, WordPress and WooCommerce run in Docker via wp-env.
  - New env vars go in `turbo.json`.
- **Release discipline:** nothing deployed, no Terraform, nothing pushed. Commit messages carry no `Co-Authored-By` or "Generated with" lines.

## Review Focus

1. **Duplicate webhook delivery or replay.** The same event arrives twice, or out of order (e.g. `payment.succeeded` after `payment.refunded`). The order is changed once, and never moves backwards. The Task 10 tests pin this.
2. **The site URL changes, or WordPress runs in a subdirectory or on a non-standard port.**
   - Connect still records the right origin and webhook URL.
   - Re-connect replaces them.
   - The Task 2 test pins the origin derivation; the Task 8 test pins re-connect.
3. **A store currency with zero or three decimals** (JPY, KWD) or a large total. The conversion and the order note are exact, with no floats. Task 4 and Task 9 tests pin this.
4. **The shopper closes the modal or tab mid-payment, then pays later from the "Pay for order" link.** The same order is reused. A second session is never created while a deposit is in flight. The Task 9 test pins this.
5. **WooCommerce auto-cancels an order whose deposit is in flight.** The cancellation is reverted, stock is kept, and a note is added. The Task 9 test pins this.

## Task overview and order

| # | Task | Depends on |
|---|---|---|
| 1 | Connections data model and key issuance | — |
| 2 | Connect API (authorize, token, status, disconnect, list/remove) | 1 |
| 3 | Connection-scoped webhook delivery, plus refund.cancelled/failed events | 1 |
| 4 | Non-USD amounts and FX provider | — |
| 5 | Merchant refunds API | 3 |
| 6 | Store settings via connection, notification_email, "You got paid" email | 2 |
| 7 | Web: /connect popup, Connected sites, notification settings, downloads + update feed | 2, 6 |
| 8 | Plugin scaffold, wp-env, settings page and Connect | 2, 7 |
| 9 | Plugin checkout (classic + Blocks), sessions, modal/redirect, expiry | 4, 8 |
| 10 | Plugin webhook receiver and order status mapping | 3, 9 |
| 11 | Plugin refunds, test purchase, go live, settings write-through | 5, 6, 10 |
| 12 | Packaging, update checker, plugin-check, end-to-end | all |

---

### Task 1: Connections data model and key issuance

**Files:**
- Modify: `apps/api/prisma/schema.prisma`.
  - New `Connection` and `ConnectAuthCode` models.
  - Nullable `connectionId` on `ApiKey`, `WebhookEndpoint` and `CheckoutSession`.
  - New `addedDomain String?` on `Connection`.
- Create: the migration `apps/api/prisma/migrations/<ts>_connections/`.
- Create: `apps/api/src/connect/connections.ts` and `connections.test.ts`.
- Modify: `apps/api/src/lib/crypto.ts`, only if a helper for issuing a key pair is missing.
- Modify: `packages/contracts/src/connect.ts` (new) and the barrel export.

**Interfaces:**
- Produces:
  - `Connection { id: 'con_<ULID>', merchantId, platform: 'woocommerce', siteUrl, siteOrigin, connectedByUserId, addedDomain: string|null, lastUsedAt, revokedAt, createdAt }`.
  - `ConnectAuthCode { codeHash (sha256, unique), connectionId, returnUrl, codeChallenge (S256), expiresAt (60 s), usedAt }`.
  - `createConnection(tx, { merchantId, userId, siteUrl, platform }): Promise<{ connection, issued: IssuedCredentials }>`. It creates, for both modes:
    - a secret key with scopes `['sessions:read','sessions:write','payments:read','refunds:write','events:read']`;
    - a publishable key;
    - a webhook endpoint at `<siteOrigin><sitePath>/wp-json/tendr/v1/webhook` with `events ['*']`, bound to the connection.
  - It also adds `siteOrigin` to `checkoutDomains` when not already present, recording `addedDomain`. If the domain limit is reached it throws `ConnectError('DOMAIN_LIMIT')`.
  - `IssuedCredentials { test: { secretKey, publishableKey, webhookSecret }, live: { … } }`. These are raw values, returned exactly once and never persisted raw.
  - `revokeConnection(tx, connectionId, by: 'site'|'dashboard'): Promise<void>`. It sets `revokedAt`, revokes the keys, deactivates the endpoints, and removes `addedDomain` only if no other live connection has that origin.
  - `siteOriginOf(siteUrl: string): { origin: string; path: string }`. It uses the URL origin and keeps a subdirectory path. It rejects non-http(s) URLs. http is allowed only for localhost-style hosts outside production, matching the `checkout-settings.ts` validation.
  - Contracts: `ConnectTokenRequestSchema { code, code_verifier, site_url }` and `ConnectTokenResponseSchema { connection_id, store: { id, name, test_account, live_account|null }, test: {...}, live: {...} }`.

- [ ] **Step 1: Write failing tests in `connections.test.ts`:**
  - `createConnection issues two secret keys whose sha256 match stored rows and whose scopes equal the list above`
  - `createConnection creates one webhook endpoint per mode bound to the connection`
  - `createConnection adds the origin once and records addedDomain`
  - `createConnection does not record addedDomain when the origin was already present`
  - `createConnection throws DOMAIN_LIMIT at 20 domains`
  - `revokeConnection makes the keys fail auth (401) and keeps a hand-added domain`
  - `revokeConnection removes addedDomain only when no other live connection shares the origin`
  - `siteOriginOf('https://shop.example.com/store/') → { origin:'https://shop.example.com', path:'/store' }`
  - `siteOriginOf('http://localhost:8888') accepted outside production`
  - `siteOriginOf('ftp://x') rejected`
- [ ] **Step 2:** Run `npm test --workspace=@tendr/api -- connections`. Expect FAIL.
- [ ] **Step 3:** Implement the schema, the migration (applied to dev and test), contracts and `connections.ts`. Signing secrets go through KeyVault as the webhooks code does.
- [ ] **Step 4:** Re-run the tests and expect PASS. Then run the api suite once.
- [ ] **Step 5:** Commit `feat(api): connections with per-site keys and webhook endpoints`.

### Task 2: Connect API

**Files:**
- Create: `apps/api/src/routes/connect.ts` and `connect.test.ts`.
- Create: `apps/api/src/connect/authorize.ts`.
- Modify: route registration and `packages/contracts/src/auth.ts`, if a new principal or permission is needed.

**Interfaces:**
- Consumes: Task 1.
- Produces these routes:
  - `POST /v1/connect/authorize`. Auth: `dashboard_user` with `settings:manage` plus step-up (owner/admin only).
    - Body `{ site_url, return_url, state, code_challenge, code_challenge_method:'S256', platform:'woocommerce', plugin_version }`.
    - `return_url` must have the same origin as `site_url`.
    - Response `{ redirect: '<return_url>?code=…&state=…' }`.
  - `POST /v1/connect/token`. Unauthenticated, rate-limited at 10/min per IP.
    - Body `ConnectTokenRequestSchema`.
    - It verifies the code hash, expiry, single use, PKCE (`base64url(sha256(verifier)) === challenge`) and that `site_url` matches.
    - Returns `ConnectTokenResponseSchema`.
    - Errors: `INVALID_GRANT` (400) for every failure mode, with no oracle.
  - `GET /v1/connect/status`. Auth: connection secret key, either mode.
    - Response `{ connection_id, mode, ready: boolean, blocking: {code, message, href}[], nudges: {code:'single_key', message, href}[] }`.
    - Blocking codes:
      - `live_account_missing` ("Finish going live on your tendr dashboard")
      - `live_account_pending` ("Your live account is still being set up")
      - `payout_missing` ("Add a payout method")
      - `store_inactive`
    - Test mode always returns `ready: true` once the test account is active.
  - `POST /v1/connect/disconnect`. Auth: connection secret key. Calls `revokeConnection(…, 'site')`. Response 204.
  - `GET /v1/connections`: list. `DELETE /v1/connections/:id`: dashboard, `settings:manage`, step-up.
  - Created sessions record `connectionId` from the authenticating key. `createSession` reads it from the principal.

- [ ] **Step 1: Write failing tests:**
  - `authorize requires owner/admin and step-up`
  - `authorize rejects return_url on a different origin`
  - `token succeeds once; second use → INVALID_GRANT`
  - `token with wrong verifier → INVALID_GRANT`
  - `token after 60 s → INVALID_GRANT`
  - `token with mismatched site_url → INVALID_GRANT`
  - `status lists live_account_missing before go-live and single_key nudge with one passkey`
  - `status ready after go-live + payout`
  - `disconnect → old key 401`
  - `DELETE /v1/connections/:id from another store → 404`
  - `session created with a connection key stores connectionId`
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement. Reuse `goLiveStatus` and the settlement checks from `sessions.ts` (`ACCOUNT_NOT_READY` logic). Do not duplicate them; extract `readinessFor(ctx, livemode)`.
- [ ] **Step 4:** Run the tests and expect PASS. Then run the api suite.
- [ ] **Step 5:** Commit `feat(api): connect authorization-code flow and connection status`.

### Task 3: Connection-scoped webhook delivery and refund outcome events

**Files:**
- Modify: `apps/api/src/checkout/webhooks.ts` (fan-out), `packages/contracts/src/checkout.ts` (`WebhookEventTypeValues`), and `apps/api/src/checkout/refunds.ts` (emit events).
- Test: `webhooks.test.ts` and `refunds.test.ts`.

**Interfaces:**
- Produces:
  - Fan-out rule:
    - an endpoint with `connectionId` set receives an event only when the event's session (or payment's session) has the same `connectionId`;
    - endpoints without `connectionId` receive everything, as today.
  - New public events:
    - `refund.cancelled { refund_id, payment_id, amount, reason }`, when the linked proposal is rejected or expires;
    - `refund.failed`, when execution fails.
  - Both are added to `WebhookEventTypeValues`, the payload allowlist and the README event list.

- [ ] **Step 1: Write failing tests:**
  - `event for connection A's session is delivered to A's endpoint, not B's, and to an unbound endpoint`
  - `refund proposal rejected → refund.cancelled delivered`
  - `refund proposal execution failed → refund.failed delivered`
  - `internal ops events still never delivered`
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement. The event's connection is resolved from the event's subject at fan-out time, never trusted from the payload.
- [ ] **Step 4:** Run the tests and expect PASS. Then run the api suite.
- [ ] **Step 5:** Commit `feat(api): connection-scoped webhooks; refund.cancelled and refund.failed`.

### Task 4: Non-USD amounts and FX provider

**Files:**
- Create: `apps/api/src/checkout/fx.ts` and `fx.test.ts`.
- Modify: `apps/api/src/checkout/sessions.ts` (`CreateSessionSchema`, conversion), `schema.prisma` (session fields), the migration, `env.ts` and `turbo.json`.

**Interfaces:**
- Produces:
  - `interface FxProvider { rate(base: string /* ISO-4217 */, quote: 'USD'): Promise<{ rate: string /* decimal: 1 base = rate USD */, source: string, asOf: Date }> }`.
  - `getUsdRate(currency: string, now: Date): Promise<FxRate>`. It caches in Redis for 60 s and throws `FX_RATE_UNAVAILABLE` when `now - asOf > 10 min` or the provider fails.
  - `convertToUsd(amount: string, currency: string, rate: FxRate): { usd: string /* 2dp, rounded up */, … }`. Uses decimal/bigint arithmetic only; reads ISO minor units from a static table.
  - Env: `FX_PROVIDER` (`fixed` | the chosen provider id), `FX_API_KEY`, `FX_FIXED_RATES` (JSON, test only). Test mode always uses the `fixed` provider.
  - Session fields: `originalAmount`, `originalCurrency`, `fxRate`, `fxSource`, `fxAsOf` (all null for USD).
  - The session GET response includes `original_amount`, `original_currency`, `fx: { rate, source, as_of }|null`.
  - `CreateSessionSchema.amount_currency` accepts any ISO-4217 code in the static table. Unknown codes return `UNSUPPORTED_CURRENCY`.

- [ ] **Step 1: Write failing tests:**
  - `NGN 78500.00 at 1 USD = 1602.04 NGN → USD 49.01 (rounded up)`
  - `JPY 1000 (0 dp) converts exactly`
  - `KWD 1.234 (3 dp) accepted; KWD 1.2345 rejected`
  - `rate 11 min old → FX_RATE_UNAVAILABLE 503`
  - `provider error → FX_RATE_UNAVAILABLE`
  - `cache hit within 60 s does not call provider`
  - `USD session unchanged and fx null`
  - `stored fields round-trip on GET`
  - `no float arithmetic` (property test against bigint reference over 1000 random amounts)
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement. Add one live provider adapter: the builder picks a reputable provider with a free or pilot tier, records the choice in the README, and puts it in the verification checklist. Network calls are mocked in tests.
- [ ] **Step 4:** Run the tests and expect PASS. Then run the api suite.
- [ ] **Step 5:** Commit `feat(api): convert non-USD order totals at session creation`.

### Task 5: Merchant refunds API

**Files:**
- Create: `apps/api/src/routes/refunds.ts`, `refunds.route.test.ts` and `apps/api/src/checkout/merchant-refunds.ts`.
- Modify: `schema.prisma` (`RefundReason` + `merchant`; `Refund.externalRef String?`; the unique index changes to exclude `merchant` from per-(payment, reason) uniqueness, plus a new unique `(paymentId, externalRef)`), the migration, and `refunds.ts` (return path accepts merchant-pays network cost).

**Interfaces:**
- Consumes: the Task 3 events, and the existing checkout-core return path in `apps/api/src/checkout/refunds.ts` (`queueReturn`, `draftReturn`, screening, review routing).
- Produces:
  - `POST /v1/refunds`. Auth: secret key with scope `refunds:write`; `Idempotency-Key` honoured.
    - Body `{ payment?: string, session?: string, amount: string, currency?: string /* default USD; else the payment's original currency, converted with the stored fx rate */, reason?: string, external_ref: string }`.
    - Response `{ id, status: 'pending'|'review', amount_usd, created }`.
    - Errors:
      - `PAYMENT_NOT_REFUNDABLE` (409): not SETTLED or partially refunded;
      - `AMOUNT_EXCEEDS_REFUNDABLE` (409);
      - `CONFLICT` (409): `external_ref` reused with a different amount.
  - `requestMerchantRefund(ctx, input): Promise<Refund>`.
    - Locks the payment and checks `amountUsd ≤ settled − Σ non-cancelled refunds`.
    - Creates a `merchant` refund row whose destination is the payment's sender wallet.
    - The merchant pays the network cost: the amount returned equals the requested amount, and the network cost is added on top from the merchant's balance. Kept-small does not apply.
    - Sanctions screening, review routing (`needs_review`, `needs_swap_route`), legal-ack gating for held/sanctioned, and system-draft proposals all reuse the existing path.

- [ ] **Step 1: Write failing tests:**
  - `refund 10.00 of a 49.00 settled payment drafts one system proposal returning exactly 10.00 worth to the sender`
  - `two partial refunds with different external_ref both draft`
  - `third refund exceeding remaining → AMOUNT_EXCEEDS_REFUNDABLE`
  - `two concurrent refunds that together exceed → exactly one succeeds`
  - `same external_ref + same amount → returns existing; different amount → CONFLICT`
  - `refund of an unsettled payment → PAYMENT_NOT_REFUNDABLE`
  - `sanctioned sender → status review, no draft`
  - `refund in NGN converts with the payment's stored rate`
  - `key without refunds:write → 403`
  - `cancelled refund frees its amount for a new refund`
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement, plus the migration on both DBs.
- [ ] **Step 4:** Run the tests and expect PASS. Then run the api suite.
- [ ] **Step 5:** Commit `feat(api): merchant-initiated refunds as signer proposals`.

### Task 6: Store settings via connection, notification email, "You got paid"

**Files:**
- Modify: `apps/api/src/checkout/checkout-settings.ts`, `routes/merchant-settings.ts`, `schema.prisma` (`Merchant.notificationEmail`, `notificationEmailPending`, `paymentEmailsEnabled Boolean @default(true)`), the migration, `auth/mailer.ts` (templates `payment_received`, `refund_sent`, `notification_email_verify`, `notification_email_changed`), and a new job handler `apps/api/src/jobs/payment-notices.ts`.
- Test: `merchant-settings.test.ts` and `payment-notices.test.ts`.

**Interfaces:**
- Produces:
  - `GET/PATCH /v1/settings/checkout` also accepts a connection secret key (in addition to `dashboard_user`).
    - A key may change only `default_fee_payer`, `default_gas_payer` and `notification_email`.
    - Each change is audit-logged with `{ by: 'connection', connectionId }`.
  - `notification_email` change:
    - stores `notificationEmailPending` and sends a single-use verify link (24 h, hashed token) to the new address;
    - the address takes effect only after the link is clicked, via `POST /v1/settings/notification-email/verify` (public, token);
    - on taking effect, the old address gets `notification_email_changed`.
  - `payment_received` email on `payment.succeeded`, sent to `notificationEmail` (or the owners' emails when null), only if `paymentEmailsEnabled`. It includes:
    - the amount in the settlement token;
    - the order total and original currency;
    - the token and chain paid;
    - the fee lines;
    - the tx link;
    - a dashboard link.
    It is idempotent per event id, reusing the `event_notices` pattern.
  - `refund_sent` email on `refund.sent`, sent to the same address.

- [ ] **Step 1: Write failing tests:**
  - `connection key can PATCH fee/gas payer and notification_email but not checkout_domains`
  - `notification_email not effective until verified; old address notified on change`
  - `expired or reused verify token rejected`
  - `payment_received sent once per event even on replay`
  - `paymentEmailsEnabled=false → no email`
  - `null notificationEmail → owners`
  - `payment_received lists original currency and fx rate for an NGN payment`
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement, plus the migration on both DBs.
- [ ] **Step 4:** Run the tests and expect PASS. Then run the api suite.
- [ ] **Step 5:** Commit `feat(api): store notification email, payment received and refund sent emails`.

### Task 7: Web: Connect popup, Connected sites, notification settings, downloads and update feed

**Files:**
- Create: `apps/web/src/app/connect/page.tsx` (plus components), `apps/web/src/app/dashboard/settings/connected-sites/page.tsx`, `apps/web/src/app/downloads/woocommerce/page.tsx`, `apps/web/src/app/v1/plugins/woocommerce/update.json/route.ts`, `apps/web/src/app/settings/notification-email/verify/page.tsx`, and `apps/web/src/lib/connect.ts` with tests.
- Modify: the dashboard checkout settings page (notification email and the payment emails switch) and the `DashboardShell` nav.

**Interfaces:**
- Consumes: the Task 2 routes and the Task 6 settings.
- Produces:
  - `/connect?site_url&return_url&state&code_challenge&platform&plugin_version`:
    1. validates the parameters (`return_url` same origin as `site_url`);
    2. if signed out, runs the existing sign-in/sign-up flow, keeping the connect parameters through the magic link in `sessionStorage` under `tendr:connect`;
    3. offers the store picker (stores where the user is owner/admin), plus "Create a new store", which runs the full project-2 signup including the recovery kit;
    4. shows the approval screen with the exact copy from spec §2.3;
    5. on approve, calls `POST /v1/connect/authorize` with step-up and sets `window.location` to the returned redirect.
  - The page CSP allows navigation only to `return_url`.
  - Connected sites: a list (site, platform, connected by, last used) and Remove (step-up).
  - `GET /v1/plugins/woocommerce/update.json` returns `{ version, download_url, sha256, requires, tested, requires_php }`. It is read from a build-time manifest, `apps/web/public/downloads/woocommerce/manifest.json`, which Task 12 writes.
  - The downloads page has a download button and the install steps.

- [ ] **Step 1: Write failing vitest tests:**
  - `parseConnectParams rejects return_url on another origin`
  - `connect params survive the magic-link round trip`
  - `store picker lists only owner/admin stores`
  - `approval copy matches spec`
  - `update.json reflects manifest`
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and expect PASS. Run the web suite and `npm run build --workspace=@tendr/web`.
- [ ] **Step 5:** Commit `feat(web): connect popup, connected sites, plugin downloads and update feed`.

### Task 8: Plugin scaffold, wp-env, settings page and Connect

**Files:**
- Create the plugin layout under `apps/woocommerce/`:
  - `tendr-pay-with-crypto.php` (header, bootstrap, HPOS and Blocks compatibility declarations)
  - `includes/class-tendr-plugin.php`
  - `includes/class-tendr-settings.php`
  - `includes/class-tendr-connect.php`
  - `includes/class-tendr-credentials.php`
  - `includes/class-tendr-api-client.php`
  - `uninstall.php`
  - `readme.txt`
  - `composer.json` (dev only)
  - `phpunit.xml`
  - `tests/`
  - `.wp-env.json`
  - `package.json` (scripts: `env:start`, `test:php`)
- Modify: the root workspaces config and `.github/workflows/ci.yml`. CI runs the PHP tests via wp-env, which Docker is available for in CI.

**Interfaces:**
- Consumes: the Task 2 and Task 7 URLs. The API base comes from the `TENDR_API_BASE` constant (default `https://api.usetendr.tech`) and the checkout base from `TENDR_CHECKOUT_BASE` (default `https://usetendr.tech`), both overridable in `wp-config.php` for local dev.
- Produces:
  - `Tendr_Credentials::store(array $issued): void`, `::get(string $mode): ?array`, `::clear(): void`.
    - Encryption: `sodium_crypto_secretbox` with a key derived by `sodium_crypto_generichash(AUTH_KEY . SECURE_AUTH_KEY, '', 32)`.
    - Stored in option `tendr_credentials` (autoload no).
  - `Tendr_Api_Client::request(string $method, string $path, array $body = [], string $mode = 'test', array $headers = []): array|WP_Error`. Uses Bearer auth, a 15 s timeout, and the `Idempotency-Key` header when given. It never logs secrets.
  - `Tendr_Connect::start(): string` (popup URL), and the REST route `GET /wp-json/tendr/v1/connect/callback`:
    - requires `manage_woocommerce` and a nonce;
    - checks `state` from the transient (10 min);
    - exchanges the code via `/v1/connect/token`;
    - stores the credentials;
    - enables the gateway in test mode;
    - renders a page that closes the popup and reloads the opener settings page.
  - `Tendr_Connect::disconnect(): void`.
  - Settings page states:
    - not connected: Connect button;
    - connected: store name, mode switch placeholder (Task 11), Disconnect.
  - Options: `tendr_mode` ('test'|'live'), `tendr_connection` (id, store name; no secrets).

- [ ] **Step 1: Write failing PHPUnit tests (in wp-env):**
  - `credentials round-trip encrypted; raw option value contains no key prefix tdr_`
  - `callback rejects bad state`
  - `callback rejects user without manage_woocommerce`
  - `callback stores credentials and sets mode test on success (API mocked via pre_http_request filter)`
  - `disconnect calls API and clears credentials`
  - `re-connect replaces stored credentials`
  - `site_url sent is home_url() including subdirectory`
  - `secrets never appear in settings page HTML`
- [ ] **Step 2:** Run `npm run test:php --workspace=@tendr/woocommerce`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit `feat(woocommerce): plugin scaffold, settings and one-click connect`.

### Task 9: Plugin checkout (classic and Blocks)

**Files:**
- Create:
  - `includes/class-tendr-gateway.php` (`WC_Payment_Gateway`)
  - `includes/class-tendr-blocks.php` (`AbstractPaymentMethodType` integration)
  - `assets/js/checkout.js` (loads `tendr.js`, opens the modal, falls back to redirect)
  - `assets/js/blocks.js`
  - `includes/class-tendr-order-status.php` (`GET /wp-json/tendr/v1/order-status/{order_key}`)
  - tests

**Interfaces:**
- Consumes: the Task 4 session fields, Task 8 `Tendr_Api_Client`, and checkout-core `tendr.js` (`Tendr.open({ sessionUrl, onEvent })`).
- Produces:
  - `Tendr_Gateway::is_available()`: false unless connected. In test mode it is true only for `current_user_can('manage_woocommerce')`.
  - `process_payment($order_id)`:
    - creates or reuses a session with `external_ref = 'wc_' . substr(sha1(home_url()), 0, 12) . '_' . $order_id`, `amount` = `$order->get_total()` as a string, `amount_currency` = `$order->get_currency()`, plus `success_url`, `cancel_url`, `customer_email` and `metadata { order_number, order_key, site_url }`;
    - uses `Idempotency-Key` = external_ref + attempt counter (order meta `_tendr_attempt`), and `expires_in` from `woocommerce_hold_stock_minutes`, clamped to 60–1800 s;
    - stores order meta `_tendr_session_id` and `_tendr_mode`;
    - returns the redirect to the order-pay step, where the modal opens.
  - Reuse rule:
    - if the stored session is open (`PENDING_DEPOSIT`, not expired), reuse it;
    - if it has a deposit in flight, never create a new one; show the session again;
    - otherwise create a new one.
  - On `FX_RATE_UNAVAILABLE` or `ACCOUNT_NOT_READY`: a checkout notice "Crypto payment is unavailable right now", with no order status change.
  - Hold-stock auto-cancel hook (`woocommerce_cancel_unpaid_order` filter):
    - call `/expire`;
    - on 409 `deposit_in_progress`, return false (keep the order), add a note, and keep the stock.
  - The thank-you page polls `order-status` every 3 s until the status is not pending, showing "Waiting for payment confirmation…". The endpoint authenticates by `order_key` and returns only the status.

- [ ] **Step 1: Write failing PHPUnit tests:**
  - `gateway hidden for guests in test mode, shown for admins`
  - `process_payment sends exact body (NGN order, JPY order) and Idempotency-Key`
  - `second process_payment on same pending order reuses open session`
  - `deposit-in-flight session is never replaced`
  - `FX_RATE_UNAVAILABLE → notice, order stays pending`
  - `auto-cancel with deposit in flight is reverted and stock kept`
  - `order-status returns status only and 404 for wrong key`
  - Blocks: `payment method registered with Blocks integration`
- [ ] **Step 2:** Run them and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and expect PASS.
- [ ] **Step 5:** Commit `feat(woocommerce): crypto checkout for classic and block checkout`.

### Task 10: Webhook receiver and order status mapping

**Files:**
- Create: `includes/class-tendr-webhooks.php`, `includes/class-tendr-order-sync.php`, and a DB table `{prefix}tendr_events` (event_id PK, received_at) created on activation and pruned daily after 30 days. Tests alongside.

**Interfaces:**
- Consumes: the Task 3 events, Task 8 credentials and Task 9 order meta.
- Produces:
  - `POST /wp-json/tendr/v1/webhook`. It:
    - verifies `Tendr-Signature` using the connection's webhook secret for the event's `livemode` (any `v1`, 300 s tolerance, `hash_equals`);
    - returns 400 on a bad signature;
    - returns 200 without action when the event id was already seen;
    - finds the order by `external_ref` (and checks metadata `order_key`);
    - returns 200 and logs for an unknown order.
  - `Tendr_Order_Sync::apply(WC_Order $order, array $event): void`. It re-reads the session or payment via the API, then applies spec §6 exactly:

| Event / state | Order |
|---|---|
| `payment.succeeded` | `payment_complete($tx)` |
| overpaid | note (extra returned, or kept under $1) |
| underpaid, open | pending + note |
| underpaid refunded | failed + note |
| `checkout.session.expired`, no payment | cancelled (stock released) |
| `payment.late` on a cancelled order | note only |
| `payment.held` | on-hold + note with review link |
| `payment.refunded` / `refund.sent` | handled in Task 11 |

  - Each note includes the token and chain, the amount, an explorer link, and the FX line when present.
  - **Monotonic:** a status never moves backwards. For example, a late `payment.processing` after completion is ignored.

- [ ] **Step 1: Write failing PHPUnit tests:**
  - `bad signature → 400 and no change`
  - `timestamp 6 min old → 400`
  - `rotation overlap: either v1 accepted`
  - `duplicate event id → single change`
  - `succeeded then processing replay → stays processing`
  - one test per §6 row asserting status and note text
  - `held → on-hold, never processing even if succeeded arrives later`
  - `payload says succeeded but API re-read says PROCESSING → no change`
  - `virtual order → completed`
- [ ] **Step 2:** Run them and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and expect PASS.
- [ ] **Step 5:** Commit `feat(woocommerce): signed webhook receiver and order status sync`.

### Task 11: Plugin refunds, test purchase, go live and settings write-through

**Files:**
- Modify: `class-tendr-gateway.php` (`supports refunds`, `process_refund`), `class-tendr-settings.php` (mode switch, settings, test purchase), and `class-tendr-order-sync.php` (refund events).
- Create: `includes/class-tendr-test-purchase.php` and tests.

**Interfaces:**
- Consumes: Task 5 `POST /v1/refunds`, Task 2 `/v1/connect/status`, Task 6 settings PATCH, and the Task 3 refund events.
- Produces:
  - `process_refund($order_id, $amount, $reason)`:
    - calls `/v1/refunds` with the payment id, `amount` and the order currency, and `external_ref` = `wc_refund_<refund_id>` (the WooCommerce refund id, which is created first);
    - adds the note "Refund of {amount} awaiting approval in tendr" with a dashboard link;
    - records refund meta `_tendr_refund_id` and `_tendr_refund_state = pending`.
    - Pending representation (builder's call per spec §7): prefer keeping the WooCommerce refund and marking it pending; the fallback is to create the refund on `refund.sent`. Whichever is chosen, WooCommerce totals must equal what actually left the account after every event.
  - Refund events:
    - `refund.sent` → final; the order becomes refunded or partially refunded, with a note;
    - `refund.cancelled` / `refund.failed` → remove the pending refund (or never create it), add a note, totals unchanged.
  - Mode switch to Live:
    - calls status with the live key;
    - switches only if `ready`;
    - otherwise lists the `blocking` messages with links;
    - always shows `nudges`.
  - Settings fields: fee payer, network-cost payer, notification email (shows "Check your inbox to confirm" until verified). They are saved through the API, with the note "Applies to all sites connected to this store".
  - "Make a test purchase" (test mode only):
    - creates an order with one fee line "Tendr test payment" of 1.00 in the store currency, `_tendr_test = yes`, no products;
    - opens its pay page;
    - the orders list shows a "Test" badge, with a bulk action "Delete tendr test orders".

- [ ] **Step 1: Write failing PHPUnit tests:**
  - `process_refund posts exact body and leaves order not refunded`
  - `refund.sent → partially refunded totals correct`
  - `refund.cancelled → pending removed, totals unchanged`
  - `two partial refunds then one cancelled → totals reflect only sent`
  - `go live blocked lists messages; ready switches mode`
  - `settings save calls PATCH and shows confirm-inbox notice`
  - `test purchase creates fee-only order flagged test, not visible in shop catalogue`
  - `bulk delete removes only test orders`
- [ ] **Step 2:** Run them and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them and expect PASS.
- [ ] **Step 5:** Commit `feat(woocommerce): refunds via signer approval, test purchase and go live`.

### Task 12: Packaging, update checker, plugin-check and end-to-end

**Files:**
- Create:
  - `apps/woocommerce/scripts/build-zip.mjs`: builds `dist/tendr-pay-with-crypto-<version>.zip`, excluding dev files; writes the sha256 and updates `apps/web/public/downloads/woocommerce/manifest.json` and the zip.
  - `includes/class-tendr-updater.php`: `pre_set_site_transient_update_plugins` and `plugins_api` filters reading `update.json`; checks the sha256 before install via the `upgrader_pre_download` filter.
  - `apps/web/e2e/woocommerce.spec.ts`.
- Modify: `ci.yml` (build the zip, run WordPress `plugin-check` in wp-env, run the WooCommerce e2e) and the README (a WooCommerce section with the manual live checklist, including the FX provider choice).

**Interfaces:**
- Consumes: everything above.
- Produces the e2e, test mode only and with no real network. It runs wp-env (WordPress + WooCommerce + the built zip) against the local API and web:
  1. Connect via the popup (sign up → store → passkey with a virtual authenticator → recovery kit → approve). Assert that no `tdr_` string appears in any WP admin HTML.
  2. Test purchase → simulate exact → the order is processing, and a "You got paid" email is captured.
  3. An NGN store converts, and the note has the rate.
  4. Refund 0.50 → the order is not refunded → approve the proposal in the dashboard → `refund.sent` → partially refunded.
  5. A second WordPress site connected to the same store receives none of site 1's events.
  6. Disconnect → the old key gets 401.
  7. In test mode, a guest doesn't see the method.

- [ ] **Step 1:** Write the e2e spec and the updater PHPUnit tests (`updater offers update from feed`, `checksum mismatch aborts install`). Run them and expect FAIL.
- [ ] **Step 2:** Implement the build, updater and CI wiring. Run `plugin-check` and expect no errors.
- [ ] **Step 3:** Run the e2e twice and expect PASS both times. Run the full API, web and PHP suites once.
- [ ] **Step 4:** Commit `chore(woocommerce): packaging, updates, plugin-check and end-to-end tests`.

---

## Spec coverage

| Spec § | Task(s) |
|---|---|
| §1 Code layout | 8, 12 |
| §2 Connect (flow, PKCE, per-site connections, disconnect, storage, re-connect) | 1, 2, 7, 8 |
| §3 Settings page, test mode, test purchase, go live | 6, 8, 11 |
| §4 Shopper checkout (Blocks + classic, modal/redirect, polling, pay-for-order, hold stock) | 9 |
| §5 Non-USD conversion | 4, 9 |
| §6 Order status mapping, webhook receiver | 3, 10 |
| §7 Refunds | 3, 5, 11 |
| §8 Merchant emails | 6 |
| §9 Updates and distribution | 7, 12 |
| §10 Compatibility | 8, 9, 12 |
| Acceptance | 12 |
