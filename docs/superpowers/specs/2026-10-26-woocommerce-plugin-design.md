# WooCommerce Plugin — Design (Project 4)

Status: draft for review. Builds on checkout core (project 3, merged 2026-10-26) and merchant accounts (project 2).

## Intent

Any WooCommerce store — physical goods, digital goods or services — can take crypto payments through Tendr. The store owner goes from "installed the plugin" to "first real payment" in under 15 minutes, **without ever copying a key or secret**. Payments settle non-custodially into the store's own NEAR account, in the token the store chose.

Copying API keys and webhook secrets by hand is where most WooCommerce payment setups stall. The heart of this project is a one-click **Connect** handoff that replaces it.

## Goals

1. A WordPress plugin, "tendr: Pay with crypto", that adds a WooCommerce payment method.
2. **Connect to tendr**: a popup on usetendr.tech where the owner signs in or signs up, picks an existing store or creates a new one, and approves with their passkey. The plugin then receives its own credentials server to server. That single approval also:
   - issues the site's test and live keys;
   - registers the site's webhook endpoint;
   - adds the site's domain to the store's checkout domains;
   - turns on the payment method in test mode.
3. **Test mode** that walks through the real WooCommerce flow using simulated outcomes, plus a "Make a test purchase" button.
4. **Go live** as one switch, which says exactly what is missing if the store isn't ready.
5. The **real payment flow**: the order is created as Pending payment, the Tendr modal opens over the store, the signed webhook moves the order on, and WooCommerce sends its normal emails. The merchant also gets a "You got paid" email.
6. **Refunds from WooCommerce admin**: a refund becomes a refund proposal for the store's signers to approve.
7. **Non-USD stores**: the order total is converted to US dollars at checkout.

## Non-goals (this project)

- WordPress.org directory listing. The pilot ships as a download; the listing comes later, but the plugin is built to the directory's rules from day one.
- Checkout logo and colours (project 5 themes). The plugin gains them once themes exist.
- AI token recommendation (a paid feature, later). Google sign-in (sign-in stays email and passkey).
- Real multi-currency, meaning the shopper pays in a currency chosen by the merchant or by the shopper's country. That comes later with the FX work in project 7.
- WooCommerce Subscriptions, pre-orders and saved payment methods.
- Shopify (project 6).

## Anti-goals (a failure even if it technically works)

- The store owner has to copy, paste or see a secret key.
- An order is marked paid on the strength of the browser (a redirect or a thank-you page) instead of a verified, signed webhook.
- Any money moves without the store's signers approving it. A refund clicked in WooCommerce must never send funds by itself.
- One connected site sees or acts on another site's orders.
- Test mode exposes "Pay with crypto" to real shoppers on a live store, and they place orders that can never be paid.
- A store on a non-USD currency gets charged at a stale or made-up rate.

## Constraints

- Domain: **usetendr.tech** for everything. The user owns usetendr.xyz too, but it is not used. Passkeys are bound to `usetendr.tech`.
- Non-custodial. Tendr never holds funds and cannot freeze them (the checkout-core sanctions-hold policy applies unchanged).
- Never store private keys or plaintext secrets in Postgres. Nothing is deployed and no Terraform is applied until the user says so. Nothing is pushed without the user's request.
- Never touch the `tendr` DB. Do not install software on the host: PHP, WordPress and WooCommerce run in Docker.
- No `Co-Authored-By` / "Generated with" lines in commits or PRs.
- Plugin licence GPL-2.0-or-later. No locked features, no tracking, and no calls home beyond the Tendr API and the update check.

## User decisions

- **Any store.** The pilot is not tailored to one merchant or product type.
- **Setup flow.** It follows the user's walkthrough: install → Connect popup (sign in or sign up, create the store with its NEAR account and passkey, choose payout, approve) → test → optional choices → go live → first payment. At go-live a single passkey gets a strong nudge to add a second device or co-owner, but it is not blocked.
- **Settlement.** It is USDC by default, or whatever token and chain the store chose. Checkout core already settles into each store's chosen settlement asset (`SettlementConfig.destAssetId/destChain`), so this needs no change.
- **Domain.** usetendr.tech (see Constraints).
- **Currency.** A non-USD WooCommerce total is converted to USD at checkout for now.
- **Refunds.** Clicking Refund in WooCommerce creates a refund proposal for the store's signers to approve.
- **Distribution.** The pilot ships as a download; the WordPress.org listing comes later.
- **Order status mapping.** As in §6 (approved).
- **Multiple sites.** When connecting, the owner either picks which existing store a site connects to or creates a new store.
- **Connect details.** As played back and approved (§2).

## Design

### 1. Where the code lives

- `apps/woocommerce/` is the plugin itself (PHP), built into `tendr-pay-with-crypto.zip`. It uses Composer for dev tooling only and has no runtime dependencies beyond WordPress and WooCommerce.
- The API work goes in `apps/api`. The Connect pages and the update feed go in `apps/web`.
- **Builder's call:** the local dev and test environment is `@wordpress/env` (Docker) running WordPress, WooCommerce and the plugin, pointed at the local API.

### 2. Connect

A standard authorization-code flow with PKCE. The code exchange happens server to server.

1. In WP admin (WooCommerce → Settings → Payments → tendr), the owner clicks **Connect to tendr**. The plugin creates a `state` and a PKCE verifier/challenge, kept in WordPress (transient, 10 min). It opens a popup to `https://usetendr.tech/connect` with these parameters:
   - `site_url` (the home URL)
   - `return_url` (an admin-only plugin REST route)
   - `state`
   - `code_challenge`
   - `platform=woocommerce`
   - `plugin_version`
2. On usetendr.tech the owner signs in (magic link and passkey), or signs up using **project 2's full signup**: accept the terms, create the store, create the NEAR test account, register a passkey, **save the recovery kit**, and choose payout. Then they pick one of the stores they own or administer, or create a new one. The popup keeps `state` and the connect parameters through magic-link sign-in.
3. **Approval screen.** It reads: "Connect *shop.example.com* to *Store name*? This lets the site create checkouts, receive payment updates and request refunds. Refunds still need your signers' approval." Only an **owner or admin** of that store can approve, and approving requires a passkey step-up.
4. On approval, the API creates a `connection` and a single-use authorization code (60 s, bound to the connection, `return_url` and `code_challenge`). The popup redirects to `return_url?code=…&state=…`. The plugin checks `state`, then calls `POST /v1/connect/token` with the code, the PKCE verifier and `site_url`, server to server. It receives:
   - the connection id
   - test and live secret keys
   - test and live publishable keys
   - test and live webhook signing secrets
   - the store name and NEAR account ids
   The popup closes itself and the settings page reloads showing "Connected to *Store name*".
5. In the same transaction as the approval, the API:
   - creates the connection's keys, scoped to `sessions:read/write, payments:read, refunds:write, events:read`;
   - creates one webhook endpoint per mode, at `<site>/wp-json/tendr/v1/webhook` with all events, bound to the connection;
   - adds the site's origin to the store's `checkout_domains`. If the domain limit of 20 is reached, the approval is refused with a clear message.
6. **Connections are per site.** Two sites on one store share the account, money, settings and dashboard, but each has its own keys and endpoints.
   - A session records the connection that created it (taken from the API key).
   - A connection's webhook endpoints receive only events about that connection's sessions and payments.
   - Endpoints the store created by hand keep receiving everything, as today.
   - Pass condition: one site never receives another site's events.
7. **Disconnect.**
   - From WordPress, "Disconnect" calls `POST /v1/connect/disconnect` with the connection's key. That revokes its keys and endpoints and deletes the stored credentials locally. It does not remove the domain.
   - From the dashboard, Settings → Connected sites lists each connection with its site, platform, connected-by and last used, and has a Remove action (owner/admin, step-up).
   - When a connection is removed, the domain is removed only if **this connection added it** (recorded at connect) and no other connection uses it. A domain the store had added by hand is never removed.
8. **Credential storage in WordPress.**
   - Secrets are stored in the options table, encrypted with a key derived from the site's `AUTH_KEY`/`SECURE_AUTH_KEY` salts (libsodium `secretbox`).
   - They are never printed in the admin UI and never sent to the browser.
   - **Builder's call:** we document that someone with database and `wp-config.php` access can read them, which is the standard WordPress limit.
9. **Re-connect** (for example after a site URL change) replaces the connection's keys and endpoint URL.

### 3. Plugin settings page (WooCommerce → Settings → Payments → tendr)

- **Before connecting:** a Connect button and a one-line explanation.
- **After connecting:**
  - the store name, plus links to the Tendr dashboard and the review queue;
  - a Test mode / Live mode switch;
  - the "Make a test purchase" button;
  - the settings below;
  - Disconnect.
- **Settings.** These write through to the store's Tendr settings via the connection key, so the plugin and dashboard always agree. They apply to test and live.
  - Who pays fees: merchant or customer.
  - Who pays network costs: merchant or customer.
  - The email for refund and payment notices. This adds a store-level setting, `notification_email`; default is the owners' emails.
  - **Builder's call (security):**
    - A new `notification_email` set from the plugin takes effect only after a verify link sent to that address is clicked. The old address is told about the change.
    - Fee and gas payer changes apply store-wide, to every connected site. The plugin says so next to the setting, and the dashboard logs who changed them, from which connection.
- **Test mode:**
  - a "Test mode" admin notice;
  - the payment method is shown **only to logged-in users who can manage WooCommerce**, so real shoppers never see a test-mode button on a live store;
  - the modal shows the checkout-core test panel with simulated outcomes ("Pay exactly", "Underpay", "Pay late", …).
- **Make a test purchase:**
  - creates a WooCommerce order flagged as a Tendr test, with one fee line "Tendr test payment" of $1.00 in the store's currency and no product, so no catalogue pollution;
  - opens the pay step for it;
  - the order then moves through statuses exactly as in §6;
  - test orders are labelled in the orders list and can be bulk-deleted.
- **Go live** (switching to Live):
  - Project 2's go-live rule is unchanged: signers plus the recovery key must add up to at least 2, and the passkey-approved mainnet account (`<slug>.tendr.near`) is created on the **Tendr dashboard** by an owner.
  - Because Connect signup includes the recovery kit, a new store already meets the rule with one passkey plus the kit.
  - The plugin calls `GET /v1/connect/status` with the live key. It returns:
    - readiness: live account active, settlement and payout set, and the store's status;
    - missing items as plain sentences with dashboard links. Examples: "Finish going live on your tendr dashboard" (no mainnet account yet), "Add a payout method", "Your live account is still being set up";
    - a non-blocking `single_key` nudge, shown when there is only one passkey: "Add a second device or a co-owner so a lost phone can't lock you out". This is the user's "strong nudge, not a block". The recovery kit still counts toward the project 2 rule.
  - It switches only when there are no blocking items. Otherwise it stays in test mode and lists the items, linking to the dashboard to finish.

### 4. Shopper checkout

Supported: **WooCommerce Blocks checkout** (a registered payment method integration) and the **classic shortcode checkout**. Declares HPOS compatibility.

1. The shopper picks "Pay with crypto" and places the order. WooCommerce creates it as **Pending payment**.
2. The plugin creates a checkout session server side, with:
   - `amount`: the order total, as a decimal string in the store currency;
   - `amount_currency`: the store currency (see §5);
   - `external_ref`: `wc_<site-hash>_<order_id>`;
   - `success_url`: the order-received page;
   - `cancel_url`: the order's pay page;
   - `customer_email`: the billing email;
   - `metadata`: order number, order key and site url.
   - The `Idempotency-Key` is the order id plus an attempt counter. `expires_in` is taken from the WooCommerce hold-stock minutes, clamped to 60–1800 s.
3. The order page loads `https://usetendr.tech/v1/tendr.js` and opens the **modal** with the session URL. If the modal can't run (script blocked, an old browser, or the session domain not registered), it falls back to a full-page redirect to the hosted URL. The store's domain was registered at connect.
4. The browser never marks the order paid. The thank-you page shows "Waiting for payment confirmation…" and polls the plugin's own order-status endpoint until the webhook has moved the order.
5. The WooCommerce "Pay for order" link on a still-pending order reuses or creates a session for the same `external_ref`. Checkout core already allows `external_ref` reuse after expiry.
6. If WooCommerce auto-cancels an unpaid order (hold stock), the plugin calls `POST /v1/checkout/sessions/:id/expire`. If the API refuses because a deposit is in flight (checkout-core I-1), the plugin **reverts the cancellation** to Pending payment with a note and does not release stock.

### 5. Non-USD stores (convert at checkout)

- `POST /v1/checkout/sessions` accepts any ISO-4217 `amount_currency`. When it isn't USD, the API converts the amount to USD **once, at session creation**, using a server-side FX rate provider.
- The session and payment store:
  - the original amount and currency;
  - the rate;
  - the source;
  - the rate timestamp;
  - the USD amount.
  The quote is then made in USD as today.
- Rates:
  - cached 60 s;
  - a rate older than 10 minutes, or a provider error, refuses the session with `FX_RATE_UNAVAILABLE` (503). The shopper sees "Crypto payment is unavailable right now", and the store can offer its other payment methods.
  - Rounding: **builder's call**, the USD amount is rounded up to the cent, so the merchant never receives less than the order total at the quoted rate.
- The plugin writes an order note: "Converted ₦78,500.00 → $49.00 at 1 USD = 1,602.04 NGN (source, time)".
- **Builder's call:** the FX provider is configurable by env (`FX_PROVIDER`, `FX_API_KEY`). A test-mode fixed-rate provider is used in tests and test mode. The provider choice for live goes in the verification checklist.

### 6. Order status mapping (approved)

| What happened | WooCommerce order |
|---|---|
| Order placed, waiting for payment | Pending payment |
| Paid in full and settled (`payment.succeeded`) | `payment_complete()` → Processing (or Completed for virtual/downloadable, as WooCommerce normally does) |
| Overpaid | Processing, with a note that the extra is being returned (or kept if under $1) |
| Underpaid, shopper can still top up | Pending payment, with a note |
| Underpaid and the deposit refunded | Failed, with a note; the shopper can try again |
| Session expired with no payment | Cancelled, and stock is released |
| Paid after the session expired, refunded | Stays Cancelled, with a note that the late payment is being returned |
| Paid from a sanctioned address (held) | On hold, with a note linking to the review queue; it never moves to Processing |
| Refunded (by the store owner or automatically) | Refunded, or partially refunded |

**Webhook receiver** (`/wp-json/tendr/v1/webhook`):
- verifies `Tendr-Signature` against the connection's secret for the event's mode. It accepts any `v1` during secret rotation, enforces a 5-minute timestamp tolerance and uses a timing-safe compare;
- is idempotent by event id, keeping a processed-events table with 30-day retention;
- finds the order by `external_ref`, and also by metadata order key;
- ignores events for unknown orders with a 200 and a log entry;
- never trusts the payload alone. It re-reads the session or payment from the API with the connection key before changing an order, so a replayed or forged-but-signed stale event can't move an order backwards.

Each note includes the token and chain paid, the amount, and an explorer link.

### 7. Refunds from WooCommerce admin

- New API route `POST /v1/refunds` (secret key, scope `refunds:write`, idempotent). Body:
  - `payment` (or `session`) id;
  - `amount` (USD decimal string, or the original currency, converted with the **payment's stored rate**);
  - `reason`;
  - `external_ref` (the WooCommerce refund id).
- Rules:
  - The payment must be SETTLED, or partially refunded.
  - The amount must be no more than what was settled minus earlier refunds.
  - **Several partial refunds per order are allowed**, as in WooCommerce. Merchant refunds are keyed by `external_ref` (the WooCommerce refund id), not by the one-per-(payment, reason) rule automatic returns use.
  - Concurrent requests are serialised per payment, so together they can never exceed the remaining amount.
- New public webhook events **`refund.cancelled`** and **`refund.failed`**:
  - `refund.cancelled` fires when the proposal is rejected or expires;
  - `refund.failed` fires when execution fails.
  The plugin uses them to undo a pending WooCommerce refund.
- It creates a merchant-initiated return (new refund reason `merchant`) to the **wallet that paid**, through the existing return path (Task 8) as a **system draft proposal**. Store signers must approve it on the dashboard. The API never sends funds by itself.
- **The merchant pays the network cost** on a refund they start themselves, so the shopper gets the full requested amount. The "deduct the fee, keep anything under $1" rule stays for automatic returns only.
- Sanctions: the paying wallet is screened before the draft, as today. If it is now flagged, the refund goes to the review queue (legal ack plus a merchant destination, as for held payments).
- Returns that need a swap route the return path doesn't support go to review (`needs_swap_route`), as today.
- WooCommerce side:
  - The plugin's `process_refund` calls the route.
  - It does **not** record the refund as done. It adds the note "Refund of $X awaiting approval in tendr" with an approve link, and returns a pending state. This uses WooCommerce's refund object, whose status the plugin tracks.
  - On `refund.sent` the refund is final, and the order becomes Refunded or partially refunded.
  - If the proposal is rejected, expires or fails, the plugin adds a note and removes the pending WooCommerce refund so the totals stay true.
  - **Builder's call:** confirm how WooCommerce represents a pending refund and choose the least surprising way. Fallback: create the WooCommerce refund only on `refund.sent`, and in the meantime show the pending amount in an order meta box.

### 8. Merchant emails

- New "You got paid" email on `payment.succeeded` for **every payment in the store**, whatever created it (plugin, API or payment link). It is sent to the store's `notification_email`, and the dashboard settings have an off switch. It contains:
  - the amount received in the settlement token;
  - the order total (and original currency);
  - the token and chain the customer paid with;
  - the fee lines;
  - a transaction link;
  - a dashboard link.
- Refund notices go to the same address:
  - "refund awaiting approval", which is the existing proposal email to signers, unchanged;
  - "refund sent".

### 9. Updates and distribution

- Download from `https://usetendr.tech/downloads/woocommerce`.
- The plugin checks `https://usetendr.tech/v1/plugins/woocommerce/update.json` (version, zip URL, sha256, tested-up-to) through the standard WordPress update hooks, so pilot stores update with the normal "Update now" button.
- The zip is built in CI, and its checksum is published in the update feed.
- `readme.txt` is in WordPress.org format, ready for the later listing.

### 10. Compatibility (builder's call)

- WordPress 6.4+, WooCommerce 8.5+ (Blocks checkout), PHP 8.0+.
- The plugin's PHP doesn't fail on any WooCommerce currency or decimal setting.
- Translatable strings use the `tendr` text domain; English only for the pilot.

## API changes summary (for the plan)

- New: `connections`, plus authorization codes; `/connect` pages in the web app; `POST /v1/connect/token`, `GET /v1/connect/status`, `POST /v1/connect/disconnect`; dashboard "Connected sites".
- Keys get a `connection_id`; sessions record it; webhook endpoints can be bound to a connection, and delivery filters by it.
- Sessions accept non-USD `amount_currency`, with server-side FX and stored conversion details.
- `POST /v1/refunds`, with new refund reason `merchant`, where the merchant pays the network cost.
- Store setting `notification_email`. A settings write path for connection keys (fee and gas payers, notification email).
- A "You got paid" email.
- An update feed and a downloads page in the web app.

## Acceptance

- In `wp-env`, a fresh WordPress + WooCommerce site installs the zip, connects through the popup (sign up → store → passkey → approve), and ends up with keys, endpoints and the domain registered. No key is ever shown.
- A test purchase goes Pending payment → Processing via a simulated exact payment. Each simulated outcome lands in the §6 status.
- In test mode, a logged-out visitor doesn't see the payment method.
- A NGN-priced store converts at checkout, and the rate is in the order note.
- A refund clicked in WooCommerce creates a proposal and leaves the order not-yet-refunded until `refund.sent`.
- Two sites on one store each receive only their own events.
- Disconnect revokes keys: the old key gets 401.
- Go live reports missing items precisely and switches once the store is ready.
- The plugin passes the WordPress.org plugin-check tool (no errors).

## Left to the builder

- Exact table and column names, the shape of the auth-code storage, and the encryption details inside WordPress.
- FX provider wiring (configurable), and the cache implementation.
- How WooCommerce's pending-refund state is represented (see §7).
- Test strategy:
  - PHPUnit for the plugin inside Docker;
  - API vitest;
  - one Playwright e2e across wp-env + the API in test mode.
