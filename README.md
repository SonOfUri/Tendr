# Tendr

**One checkout. Every way to pay.**

Tendr is a universal checkout and payment-orchestration layer for digital commerce. Merchants integrate once; customers pay with supported digital assets; Tendr coordinates checkout, verification, and merchant notifications.

NEAR Intents is an optional execution integration behind the scenes—not the Tendr brand.

> **Status:** stores can create checkout sessions, embed checkout, receive signed webhooks and
> accept live payments through 1Click when the deployment is enabled and the store has a configured
> wallet and settlement asset. Hosted Test mode moves Tidepool testnet tokens. The current native Intents wallet uses a
> dedicated owner passkey; the contract-account and sponsored-payment paths have separate rollout
> requirements. See the [merchant and developer docs](apps/docs/README.md) for current integration guidance.

## Monorepo layout

```text
Tendr/
├── apps/web          # Next.js App Router + PWA
├── apps/api          # Fastify REST /v1 (api) + BullMQ worker
├── apps/docs         # Mintlify docs
├── packages/contracts|sdk|ui|config-*
├── apps/api/prisma   # schema, migrations, seed
└── infra
    ├── docker        # Postgres (host port 5433) + Redis (host port 6380)
    └── terraform     # GCP Cloud KMS + Railway (written, not applied)
```

## What is implemented

- PostgreSQL schema for merchants, keys, sessions, payments, refunds, webhooks, themes and the
  event log, with composite FKs that keep merchants and test/live modes apart
- `/v1` gateway: secret and publishable API keys per mode, scopes, optional HMAC request
  signing (`Tendr-Signature`), per-principal rate limits, `Idempotency-Key` on `POST`
- Scoped data access: every request reads and writes only its own merchant and mode
- Append-only `events` table with an outbox drained by the worker
- `KeyVault`: envelope encryption and Ed25519 / secp256k1 signing (local file or Cloud KMS)
- Health checks for the api (`GET /v1/health`) and worker (`GET /health` on `WORKER_HEALTH_PORT`)
- NEAR merchant accounts with a passkey threshold contract (see below)
- Checkout: sessions, the hosted / modal / widget checkout, 1Click quotes, the payment watcher
  with per-transfer settlement checks, sanctions screening, returns, signed webhooks (see
  [Checkout](#checkout))

## What is not implemented yet

- Live checkout is not switched on: it waits for the mainnet checks and the contract audit below
- Merchant KYC

## Quick start

Requires Node 22+, npm 10+ and Docker.

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d   # Postgres + Redis
npm install
npm run build --workspace=@tendr/contracts                # used by the seed script
npm run db:migrate:dev --workspace=@tendr/api             # dev database (DATABASE_URL)
npm run db:migrate:test --workspace=@tendr/api            # test database (TEST_DATABASE_URL)
npm run db:seed                                           # prints the demo API keys once
npm run dev                                               # web + api + worker
```

An existing local `tendr` database that still has the old sandbox migration needs a reset: run
`npm run db:migrate:dev --workspace=@tendr/api` (it prompts before resetting) or point
`DATABASE_URL` at a fresh database.

The seed is idempotent: it creates the **Demo Merchant** with secret keys (every scope) and
publishable keys (`sessions:read`, `sessions:write`, `payment_links:read`) for test and live mode
and prints the raw keys once (a rerun prints "already seeded" and no keys).
Keys look like:

| Key               | Prefix         | Use                    |
| ----------------- | -------------- | ---------------------- |
| Secret, test      | `tdr_test_`    | server-side, test mode |
| Secret, live      | `tdr_live_`    | server-side, live mode |
| Publishable, test | `tdr_pk_test_` | browser, test mode     |
| Publishable, live | `tdr_pk_live_` | browser, live mode     |

```bash
curl -H "Authorization: Bearer tdr_test_..." http://localhost:4000/v1/ping
# {"merchantId":"mer_...","livemode":false,"principal":"secret_key","scopes":[...]}
```

Live mode has no settlement config until you seed one with a real payout address
(`SEED_PAYOUT_ADDRESS=0x... npm run db:seed`); the zero address is refused.

Local Postgres is on **host port 5433** and Redis on **6380** (see `.env.example`), so they do
not collide with other local services.

- Web: http://localhost:3000
- API: http://localhost:4000 (`GET /v1/health`)
- Worker health: http://localhost:4100/health
- Docs: `npm run dev:docs` (Mintlify via `npx`)

### Merchant accounts (NEAR)

Each store gets a NEAR account (`<slug>.tendr.near` live, `<slug>.tendr.testnet` test) with **zero
access keys**. A threshold contract (`onchain/merchant-account`) is the only thing that can act for
it, and signers are passkeys verified inside the contract. Design:
`docs/superpowers/specs/2026-10-25-merchant-accounts-design.md`.

**What waits 24 hours.** The contract holds these for 24 h after they reach the threshold, emails
every signer when the wait starts, lets any signer cancel during it, and re-checks them when they
run: swap withdrawals, refunds over the daily refund cap, raising a limit or the refund cap,
upgrades, and every security change that widens who can sign or how — adding a signer, adding a
passkey to a signer, replacing or clearing the recovery key, lowering the approval threshold, and
changing the allowed origins (ruling R34). Removing a signer or a key and raising the threshold
apply at once, so signers can always lock someone out immediately. A new saved address can receive
money 24 h after it is approved.

**Sweeps and limits.** Auto-sweeps are not counted against the per-withdrawal or per-day limits:
a sweep can only pay the saved address pinned in its rule, which itself waited 24 h before it could
receive money. Withdrawals and refunds are limited; sweeps are bounded by the sweep rule instead.

**Account storage.** Each proposal's record stays in the account contract's storage, paid from the
account's own NEAR (seeded with `MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO`, 0.5 NEAR by default).
Measured on the sandbox (`storage_per_proposal` in `onchain/merchant-account/tests/sandbox.rs`), one
proposal from creation through execution adds 401–586 bytes (a withdrawal 456, the first withdrawal
of an asset 586 with its limits state, an AddSigner 516): about 0.006 NEAR. The watcher checks every
active account on each reconcile and, when its free balance would cover fewer than 50 more
proposals (600 bytes each, 0.3 NEAR), sends `MERCHANT_ACCOUNT_STORAGE_TOPUP_YOCTO` (0.5 NEAR by
default) from `funding-near`. Top-ups are `funding.topup` events and count against
`FUNDING_DAILY_CAP_YOCTO`; if the cap blocks one, the account is flagged
(`merchant_account.storage_low`) and the dashboard's account home shows a warning.

**Known limitations.** Proposals, approvals, removed-address tombstones and limit windows are never
pruned yet, so an account's storage only grows; pruning is deferred to a later contract version.
Until then the top-ups above keep accounts writable.

**Local development needs no NEAR node, GCP or contract build.** Outside production
`NEAR_CLIENT_DRIVER` defaults to `fake`, an in-memory NEAR client. Set `NEAR_FAKE_SIMULATE=1` (e2e
and offline demos only; refused with any other driver) to also run the contract's rules in memory.
`npm run e2e:serve --workspace=@tendr/api` starts the API and worker in one process for the
Playwright dashboard tests. Keep `MAIL_DRIVER=log` (the default in development): sign-in and
recovery emails are written to the log and to `apps/api/.mail/`.

**Testnet publish** (manual, never run by CI). Needs Docker and a funded `tendr.testnet` key:

```bash
export NEAR_PUBLISH_PRIVATE_KEY=ed25519:...        # full-access key of tendr.testnet
npm run onchain:publish:testnet --workspace=@tendr/api -- --network testnet
```

It builds `onchain/` in Docker (`onchain/scripts/build.sh`), publishes the `testnet-admin` build of
the merchant-account contract as a global contract, deploys `mock-intents` to
`intents-mock.tendr.testnet`, and prints the code hash. Put that in `MERCHANT_ACCOUNT_CODE_HASH_TEST`
and confirm the testnet asset ids it lists against `apps/web/src/lib/asset-registry.ts`. Any
`--network` other than `testnet` is refused.

**Mainnet checks** (manual, spends real funds, never run by CI). Verifies the spec's "Assumptions to
verify early" with a funded mainnet account of your own: `p256_verify` on mainnet, a 1Click swap
delivered to a contract account (`recipientType INTENTS`, `refundType INTENTS`), a threshold-approved
`ft_withdraw` with a `WITHDRAW_TO:` memo to an EVM address you control, sub-account creation without
`AddKey`, and NEP-145 storage needs. It also prints the observed omft token account names (to
confirm `POA_CHAIN_PREFIXES` in `money.rs` and `poa_suffix`), the real verifier's return values, and
the shape of RPC `InvalidNonce` and timeout errors. The saved-address delay is 24 h, so it runs in
two phases:

```bash
onchain/scripts/build.sh && onchain/scripts/build.sh --features probe merchant-account
export VERIFY_FUNDER_ACCOUNT_ID=you.near VERIFY_FUNDER_PRIVATE_KEY=ed25519:...
npm run onchain:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase prepare
# 24 hours later:
npm run onchain:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase finish --cleanup
```

Before spending anything it fetches a dry 1Click quote and prints a spend plan computed from the
actual wasm sizes. The swap is capped at 5 USD by the quote's own `amountInUsd` (a missing or higher
value is refused); the funder's NEAR and origin-token balances must cover the plan. With the
default build sizes the plan is roughly: probe account about 3.9 NEAR (deleted automatically,
returns), throwaway merchant account about 4.8 NEAR (returns on cleanup), and **not recoverable**:
0.01 NEAR for the zero-key sub-account (it has no key, so it can never be deleted), up to 0.00125
NEAR for the 1Click deposit address's `storage_deposit`, and about 0.05 NEAR of gas, plus the swap
(about 1 USD by default, mostly recovered by the withdrawal minus bridge fees).

It prints PASS / FAIL / INFO per check and stops at the first FAIL. A first FAIL may be a
script-shape error against the 1Click and verifier APIs, which the script was written against
without being able to call them: read the printed response before concluding the contract is wrong.
The `probe` build adds a `probe_p256` view and exists only for this script; it is never published.

After any FAIL following the creation of the throwaway merchant account, the script prints the
account id and the exact recovery command. `--phase cleanup` works from any saved state: it
withdraws any held balance if the saved address is already active, re-reads the balance and
refuses to delete the account while it still holds tokens unless you pass `--abandon-balance` (it
prints what would be given up), then deletes the throwaway account (NEAR returns to you) and the
state file. It validates the state file first (the account must be `acct-<id>.<your account>`),
and `prepare` refuses to run while a state file exists. The state file holds the throwaway passkey, which
is the account's only signer, so keep it private (it is created mode 0600 and gitignored) until
cleanup.

**Audit gate.** The contract must be independently audited before any live merchant holds funds.
The mainnet build is published as a global contract and `MERCHANT_ACCOUNT_CODE_HASH_LIVE` is set
ahead of the audit (deploy runbook, step 9), but the platform switch `LIVE_MODE_ENABLED` stays
`false` until the audit covers that exact hash: while it is off, going live and provisioning a live
account are refused (`403 LIVE_MODE_UNAVAILABLE`). Provisioning is also refused while
`MERCHANT_ACCOUNT_CODE_HASH_LIVE` is unset.

**Production checklist for merchant accounts**

- Fund the `relayer-accounts` NEAR account out of band. It is the implicit account whose id is the
  lower-case hex of the key's 32-byte Ed25519 public key (`implicitAccountId` in
  `apps/api/src/near/tx.ts`; read the public key from Cloud KMS). It only needs gas money.
  `funding-near` creates accounts and is capped by `FUNDING_PER_ACCOUNT_YOCTO` and
  `FUNDING_DAILY_CAP_YOCTO`; keep its balance low.
- `MAIL_DRIVER` has no working default in production (`unconfigured` makes sending fail loudly).
  Configure a real mail provider before enabling signup: until then no one can verify an email.
- The API answers `401 UNAUTHENTICATED` for a missing or expired dashboard session and for a failed
  passkey ceremony (the dashboard does not sign the user out on a failed ceremony). See
  `apps/docs` troubleshooting.
- The API and the dashboard may live on different subdomains. The CSRF value is returned as
  `csrfToken` in the body of every response that starts or describes a session and is sent back as
  the `Tendr-CSRF` header, so the dashboard does not depend on reading the API's cookie. Set
  `WEBAUTHN_RP_ID` to the parent domain (`usetendr.tech`) and list every dashboard origin in
  `WEBAUTHN_ORIGINS`.

### Cloud KMS check

Production keeps keys in Google Cloud KMS. To check that the GCP project supports both curves
(envelope encryption, an Ed25519 signature valid for NEAR, a secp256k1 signature that recovers to
the key's EVM address), set the `GCP_*` variables in `.env` and run:

```bash
npm run kms:verify --workspace=@tendr/api
```

It creates keys in a separate `tendr-verify` key ring and deploys nothing.

### Windows notes

- If `listen EACCES` occurs on `API_PORT`, Windows may have excluded that port range — set
  `API_PORT=18080` and matching `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL`.
- The API defaults to `API_HOST=127.0.0.1`.

Never embed secret keys (`tdr_test_` / `tdr_live_`) in client bundles; only publishable keys
belong in the browser.

## Checkout

Design: `docs/superpowers/specs/2026-10-25-checkout-core-design.md`. A shopper pays with any token
1Click supports. 1Click swaps it into the store's settlement asset and delivers it straight to the
store's merchant account (or, in `wallet` payout mode, to its saved payout address). Tendr never
holds the money. An order counts as paid only when 1Click reports `SUCCESS` and the watcher finds,
in the receipts of 1Click's settlement transaction, a transfer of at least the quoted amount to the
store. Balance changes are never used, and browser messages never mark anything paid.

### Creating a session

Call this from your server with a secret key (`sessions:write`). `POST` accepts `Idempotency-Key`.

```bash
curl -X POST http://localhost:4000/v1/checkout/sessions \
  -H "Authorization: Bearer tdr_test_..." -H "Idempotency-Key: order-1042" \
  -H "Content-Type: application/json" \
  -d '{"amount":"25.00","amount_currency":"USD","external_ref":"order-1042",
       "success_url":"https://shop.example/thanks","cancel_url":"https://shop.example/cart"}'
# {"id":"ses_...","client_secret":"ses_..._secret_...",
#  "url":"http://localhost:3000/ses_...#cs=ses_..._secret_...",
#  "expires_at":"...","status":"PENDING_DEPOSIT"}
```

- `amount_currency` is `USD` (at most 2 decimals), any ISO 4217 currency code (see below), or
  exactly the store's settlement asset id. Anything else gets `400 UNSUPPORTED_CURRENCY`, with
  `details.allowed: ["ISO 4217 code", "<settlement asset id>"]` (this used to be
  `["USD", "<settlement asset id>"]`; `USD` is one of the ISO codes). The settlement asset and
  destination come from the store's settings, and the request cannot set them.
- A non-USD total (`NGN`, `EUR`, `JPY`, …) is converted to USD **once, at creation**:
  - The amount may have at most the currency's ISO minor units (`JPY 1000`, `NGN 78500.00`,
    `KWD 1.234`; `KWD 1.2345` is a `400 VALIDATION_ERROR`).
  - Rates read the way a merchant does: **"1 USD = R <currency>"**, and `usd = amount / R`, rounded
    **up** to the cent so the store never receives less than the order total at the quoted rate.
    Example: `NGN 78500.00` at `1 USD = 1602.04 NGN` is `USD 49.01` (78500 / 1602.04 = 49.00002…).
    The arithmetic is exact (scaled bigint), never floating point.
  - The USD amount must pass the same checks as an amount sent in USD. The session is then priced
    in USD as usual: `amount` / `amount_currency` on the session are the USD values.
  - Rates are cached per currency for 60 s. If the provider fails, or its rate (by the provider's
    own timestamp) is more than 10 minutes old, the session is refused with
    `503 FX_RATE_UNAVAILABLE`; there is no fallback to a stale rate. A stale cached rate is
    refetched rather than served, and a rate that arrives stale is never cached. Show the shopper
    "Crypto payment is unavailable right now" and offer the store's other payment methods.
  - Live sanity band: the last good live rate per currency is kept for 7 days. A new rate more
    than 50% away from it in either direction is refused (`503 FX_RATE_UNAVAILABLE`, logged) and
    recorded as a candidate. If later fetches stay within ±5% of the candidate, it is accepted as
    the new reference once it has been seen for at least 10 minutes across at least 3 fetches, so
    a real devaluation is refused for about 10 minutes, not locked out. A fetch back inside the old
    band clears the candidate, and a rate that keeps jumping more than 5% never qualifies. The
    first rate ever seen for a currency is accepted.
  - An `Idempotency-Key` replay returns the stored session; it never fetches a new rate.
  - Test mode always uses built-in **test rates**: approximate round rates for every currency in
    WooCommerce's default list, not market rates, so `fx.source` is `"fixed (test rates)"`.
    `FX_FIXED_RATES` overrides entries. This holds whatever `FX_PROVIDER` says, production included.
  - Live mode always uses the live adapter (`FX_PROVIDER=openexchangerates` with `FX_API_KEY`) and
    never fixed rates, whatever `FX_PROVIDER`, `FX_FIXED_RATES` or `NODE_ENV` say. With no live
    provider or key configured, live non-USD sessions get `503 FX_RATE_UNAVAILABLE`.
- Optional fields:
  - `customer_email`, used only for refund contact and receipts;
  - `metadata`, up to 50 string keys;
  - `fee_payer` and `gas_payer` (`merchant` | `shopper`);
  - `payment_link_id`;
  - `expires_in`, 60 to 1800 seconds. The default is 30 minutes.
- `external_ref` is your order id. Only one session that is open, being paid or paid may hold it,
  or you get `409 CONFLICT`. An expired, late or held order can get a new session. A session past
  its expiry that still has a deposit in flight (a payment being processed, a deposit the shopper
  reported inside its deadline, or an address not checked since the expiry) keeps holding it:
  you get `409 CONFLICT` with `details.reason: deposit_in_progress`. Retry shortly; never ask the
  shopper to pay again.
- Without an active merchant account and settlement settings in that mode, you get
  `409 ACCOUNT_NOT_READY`.
- `GET /v1/checkout/sessions/:id` (`sessions:read`) returns the session with its payments,
  refunds and totals. A converted session also has `original_amount` (in the currency's minor
  units, e.g. `"78500.00"`), `original_currency` and
  `fx: { rate, source, as_of }` (`rate` is "1 USD = rate <original_currency>", `as_of` is the
  rate's own timestamp). For a USD or settlement-asset session these are `null`.
- `POST /v1/checkout/sessions/:id/expire` cancels an open session. It becomes `EXPIRED` with
  reason `canceled`. While a deposit is in flight it is refused with `409 DEPOSIT_IN_PROGRESS`
  (`details.reason: deposit_in_progress`), so an on-time payment is never turned late.
- `url` is the hosted checkout. The client secret travels in its `#cs=` fragment, so it never
  reaches a server in a request line. Redirect the shopper to it, or embed it as below.

### Embedding (tendr.js)

The web app serves `/v1/tendr.js`, built from `apps/web/src/embed/tendr.ts` (under 10 KB):

```html
<script src="https://usetendr.tech/v1/tendr.js"></script>
<script>
  // sessionUrl is the session's `url`, passed through unchanged.
  Tendr.open({ sessionUrl, onEvent: (e) => console.log(e) }); // modal; Esc or × closes it
  Tendr.mount(document.getElementById('pay'), { sessionUrl, onEvent }); // inline widget
</script>
```

- Events are `{ type: 'ready' | 'status' | 'complete', sessionId, status }` and
  `{ type: 'close' }`. They are informational only: mark orders paid from the webhook.
- tendr.js frames and listens to one origin, set at build time:
  - `TENDR_CHECKOUT_BASE_URL` when set;
  - else `CHECKOUT_BASE_URL`;
  - else `https://usetendr.tech`.

  The API builds session URLs from `CHECKOUT_BASE_URL`, so the two must name the same origin.
  tendr.js refuses a `sessionUrl` on any other origin.

- If a wallet cannot open inside the frame, the checkout opens that wallet step in a popup window
  on its own origin, and the frame picks up the result.

### Refunding a payment

`POST /v1/refunds` returns money to the wallet that paid. It needs a secret key with
`refunds:write`. It never moves funds by itself: it drafts a `refund` proposal that the store's
signers approve in the dashboard.

```json
{ "payment": "pay_…", "amount": "10.00", "external_ref": "wc-refund-123", "reason": "damaged" }
```

- Give `payment` or `session` (one of them). The payment must be `SETTLED` or
  `PARTIALLY_REFUNDED` (else 409 `PAYMENT_NOT_REFUNDABLE`).
- `amount` is in USD. Or set `currency` to the order's original currency (the session's
  `original_currency`): it is converted at the rate stored on the session, rounded up to the cent.
  A refund of everything that is left in the original currency equals exactly what is left. Any
  other currency is 400 `UNSUPPORTED_CURRENCY`.
- Several partial refunds are allowed. Together they can never pass the order amount: 409
  `AMOUNT_EXCEEDS_REFUNDABLE`. A refund whose proposal was rejected, expired or failed no longer
  counts.
- `external_ref` is your id for the refund. The same `external_ref` again with the same amount
  returns the existing refund (200). With another amount it is 409 `CONFLICT`. `Idempotency-Key`
  is honoured too.
- You pay the network cost: the shopper gets the full amount, and the estimated network fee is
  added on top from your account. If your account does not hold that much, the request is 409
  `AMOUNT_EXCEEDS_REFUNDABLE`.
- The response is `{ id, status, amount_usd, refund_external_ref, payment_id, created }`. `status`
  is `pending` (awaiting your signers), or `review` when a person must act first: the paying
  wallet is now sanctioned (legal acknowledgement and another destination, as for a held payment),
  the asset cannot reach the shopper's chain directly, or the shopper sent from an exchange and
  must say where to send it. A repeat of an earlier refund can also say `sent` or `cancelled`.
- A key issued to a connected site refunds only payments made with that site's keys, or with the
  keys of the connection it replaced when the site re-connected. Anything else is 404.
- Then follow `refund.pending`, `refund.sent`, `refund.cancelled` and `refund.failed` (see
  Webhooks).
- `POST /v1/refunds/:id/cancel` (same key and rules) cancels a refund that has no proposal yet:
  not drafted, or in review. It frees its amount and sends `refund.cancelled`. Cancelling it
  again returns it unchanged. A refund that already has a proposal is 409 `REFUND_HAS_PROPOSAL`:
  your signers reject it (or let it expire) in the dashboard instead. The dashboard's review
  queue has the same action (`money:request`, with a fresh passkey).

### Registering checkout domains

Only the store's registered domains may frame the checkout (CSP `frame-ancestors`). Other sites
get a refused frame. Register domains in the dashboard under Settings → Checkout. The API route is
`PATCH /v1/settings/checkout`; it needs a dashboard session with `settings:manage` and a fresh
passkey:

```json
{ "checkout_domains": ["https://shop.example", "https://www.shop.example"] }
```

- Each entry is an origin: a scheme, a host and an optional port. Paths and wildcards are refused.
- Production accepts `https://` only. Outside production, `http://localhost` also works.
- Test and live mode share the same domains.
- The checkout sends its `postMessage` events only to the registered origin that framed it.

### Store notices and settings from a connected site

`GET/PATCH /v1/settings/checkout` also returns `notification_email`, `notification_email_pending`
and `payment_emails_enabled`.

- A connected site's key (one issued by Connect) may read the settings and change only
  `default_fee_payer`, `default_gas_payer` and `notification_email`. Any other field is
  `403 FIELD_NOT_ALLOWED`; a key you made by hand is `403`. Payer changes apply store-wide, to every
  connected site. Every change is in the audit log with who made it (`actor`: a user or a
  connection).
- A new `notification_email` takes effect only after the link mailed to it is used. Until then it
  is `notification_email_pending`, and nothing else is sent there. The link
  (`/settings/notification-email/verify?t=…` on the web app) works once and lasts 24 hours; a new
  request replaces it. The web page calls `POST /v1/settings/notification-email/verify` with
  `{ "token": "…" }` (public, 10 / minute / IP; any bad link is `400 INVALID_LINK`). The current
  address (or the owners when there is none) is warned as soon as a change is requested, with the
  new address masked and where the request came from, and told again when it takes effect.
  Revoking a connected site cancels a change that site requested. `null` sends notices to the
  owners' emails again (the default).
- These mails go out after the change is saved: a mail failure never undoes a settings change,
  and the mail is retried.
- "You got paid" (`payment_received`) goes on every `payment.succeeded`, while
  `payment_emails_enabled` (dashboard only; default on). "Refund sent" (`refund_sent`) goes on
  every `refund.sent`. Both go to the notification email, else the owners, once per event and
  recipient; test-mode subjects start with `[Test]`.

### Webhooks

Add endpoints in the dashboard (Webhooks) or with `POST /v1/webhooks/endpoints`, for example
`{ "url": "https://...", "events": [...] }`. Omit `events` to receive all of them. The signing
secret (`whsec_...`) is shown once, at creation and on rotation.

- Events:
  - `checkout.session.expired`;
  - `payment.detected`, `payment.processing`, `payment.succeeded`, `payment.refunded`,
    `payment.late`, `payment.held`;
  - `refund.pending`, `refund.sent`, `refund.needs_address`, `refund.cancelled`, `refund.failed`;
  - `gas.budget_low` (sponsored gas reserved + spent crossed 80 % of the month's budget) and
    `gas.budget_exhausted` (a payment was not sponsored because the budget is used up), each at
    most once per calendar month (UTC) per mode. `data`: `mode` (`test`/`live`), `month`
    (`YYYY-MM`), `budget_usd`, `reserved_usd`, `spent_usd`, `remaining_usd`, plus
    `requested_usd` on `gas.budget_exhausted`;
  - `hook.succeeded` and `hook.failed` for integrator stores (the contract hook call; see
    [Gasless payments](#gasless-payments)). `data`: `payment_id`, `session_id`, `external_ref`,
    `hook_call_id`, `chain`, `contract`, `attempts`, `tx_hash`, plus `error` on `hook.failed`.
- `refund.cancelled` means the refund's proposal was rejected by the signers or expired;
  `refund.failed` means it failed when it executed on chain. Either way no money moved for that
  proposal. `data` has `refund_id`, `payment_id`, `session_id`, `external_ref`, `asset`, `amount`
  (base units of `asset`, as in `refund.sent`), `reason`, and `status` (`cancelled`, `expired` or
  `failed`). Each is sent at most once per proposal, and only once the proposal can no longer
  execute on chain. An automatic return goes back to the review queue, where it can be drafted
  again. A refund you started (`POST /v1/refunds`) is closed instead: undo it on your side and
  start a new refund if you still want one.
- Every `refund.*` event of a refund you started also carries `refund_external_ref`, the
  `external_ref` you gave `POST /v1/refunds` (your refund id). `external_ref` stays your order id.
  The key is absent on automatic returns.
- `payment.refunded` for a refund you started fires once, when the refunds sent cover the whole
  order amount (`reason: merchant`, `refund_via: merchant`). The payment is `PARTIALLY_REFUNDED`
  until then.
- `refund.sent` is final. It can follow an earlier `refund.cancelled` or `refund.failed` for the
  same `refund_id`, when the return was drafted again and the new proposal executed. (For a
  refund you started, only in the rare case where a proposal reported as ended still executed on
  chain. The money did leave: record the refund again.)
- An endpoint created by a connected site (Connect) receives only events for the sessions and
  payments created with that site's keys. Endpoints you add yourself receive every event. When a
  site re-connects, events for its earlier orders go to the new connection's endpoints. After a
  disconnect or a removal they go to no site endpoint.
- A payment can have more than one return, each with its own `refund.*` events. For example, a
  late overpayment has a `late` return and an `overpaid` return for the excess. `payment.refunded`
  and a session's `REFUNDED` status can arrive before every return has been sent. Track each
  return by its own `refund.sent`, keyed on `refund_id`.
- The body is `{ id, type, created, livemode, data }`. `data.external_ref` is your order id.
- Failed deliveries are retried with exponential backoff for 3 days. You can resend any delivery
  from the dashboard.
- A retry or a resend keeps the event `id`, also sent as the `Tendr-Event-Id` header. Deduplicate
  on it.

Every delivery carries `Tendr-Signature: t=<unix>,v1=<hex>`. The hex is
HMAC-SHA256(secret, `<t>.<raw body>`), and `t` is the time of that attempt. For 24 hours after you
rotate a secret, the header carries a second `v1=` signed with the old secret, so check every `v1`
value. Verify the raw bytes, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 300;

/**
 * rawBody: the request body as a Buffer. secrets: the secret(s) you hold (both while you switch to
 * a rotated one). True when any v1 matches any secret and t is recent.
 */
export function verifyTendrSignature(rawBody, header, secrets, now = Date.now() / 1000) {
  let t = NaN;
  const signatures = [];
  for (const part of String(header ?? '').split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't') t = Number(value);
    else if (key === 'v1' && value) signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isInteger(t) || signatures.length === 0) return false;
  if (Math.abs(now - t) > TOLERANCE_SECONDS) return false;
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
    for (const sig of signatures) {
      // Every pair is checked (no early exit), each in constant time.
      if (sig.length === expected.length && timingSafeEqual(sig, expected)) ok = true;
    }
  }
  return ok;
}
```

### Payment links

Design: `docs/superpowers/specs/2026-10-30-payment-links-design.md`. A merchant makes a reusable link,
fixed or open amount, in USD or an ISO 4217 currency, and shares `CHECKOUT_BASE_URL/pay/<store>/<link>`
(`?mode=test` for test links) or its QR code. The payer presses Pay and the normal checkout takes over.

- Merchant API: `POST|GET /v1/payment_links`, `GET|PATCH|DELETE /v1/payment_links/:id`, with scopes
  `payment_links:read` / `payment_links:write`. `slug` is immutable; `PATCH` clears optional fields
  with `null`; `DELETE` archives. Minimum $1.00 USD equivalent per payment.
- Public API (no key): `GET /v1/payment_links/public/:merchant/:link` and
  `POST .../sessions`, rate-limited per payer IP.
- `max_uses`: each open session reserves a use under a row lock (`LINK_RESERVED`); late deposits are
  refunded and do not count. Link sessions start with a 5-minute expiry until the first quote.
- Web: `/pay/<store>/<link>`, `/qr` (PNG, `?format=svg`) and `/opengraph-image` preview cards.
- Webhook events of link sessions carry `payment_link_id` and `payer_note`.
- Deploy settings: `WEB_INTERNAL_TOKEN` (API and web, 32+ characters), `TENDR_ASSET_ORIGIN` (web, logo
  origin for preview cards) and `CHECKOUT_BASE_URL` (the canonical base, the same in API and web).
- Docs: `apps/docs/payment-links/`, `apps/docs/api-reference/payment-links.mdx`; handover for the
  dashboard: `docs/handover/2026-10-30-payment-links.md`.

### Checkout themes

Merchants brand the hosted checkout and payment link pages with **themes**: a settings block
(name, logo, light/dark/auto palettes, font, corners, Pay button words), a list of blocks around
a sealed payment block, a thank-you page, and optional custom CSS and HTML. Start from a preset or
pull a brand from a website or a connected WooCommerce store. Details: `apps/docs/themes/` (guide
and safety rules), `apps/docs/api-reference/themes.mdx`, and the handover note
`docs/handover/2026-10-30-checkout-themes.md`.

- API: `/v1/themes` (CRUD, `validate`, `preview`, `publish`, `default`, `from-website`,
  `from-store`) and `/v1/theme-assets`. Publish and default need a live key or a stepped-up
  dashboard user; a test key can draft, preview and validate. Sessions take `theme_id` and
  `line_items` (up to 50).
- A live session renders only a published theme; a test session may name a draft. A broken theme
  falls back to the Tendr default look and never stops a payment.
- The SDK has `client.themes`, `client.themeAssets` and `client.checkoutSessions.create`.

Environment (API; `TENDR_ASSET_ORIGIN` also in the web app, where the middleware uses it for the
CSP and which Next bakes in at build):

| Variable | Meaning |
| --- | --- |
| `TENDR_ASSET_ORIGIN` | Public base URL of the asset bucket. Must be `https://` in production. |
| `ASSET_STORE_DRIVER` | `s3` or `memory`. Defaults to `memory` outside production; production requires `s3`. |
| `ASSET_S3_ENDPOINT`, `ASSET_S3_REGION` | S3 or R2 endpoint and region (`auto` for R2). |
| `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY` | Bucket and credentials; required with `s3`. |
| `ASSET_S3_FORCE_PATH_STYLE` | `true` for MinIO, `false` for R2/S3. |

The compose file has a `minio` service (and a `minio-init` bucket setup) on ports 9100 and 9101 for
a local S3 bucket. Docker Hub no longer serves the `minio/minio` image, so the service does not
start until its image is replaced; local runs use the in-memory store by default. Production needs
Postgres 15 or newer, and response headers on the asset origin (see the handover note).

### Test mode

Hosted Test keys (`tdr_test_`) use **Tidepool** for actual testnet payments, settlement and withdrawals
with USDC/USDT on NEAR testnet, Base Sepolia and Solana devnet. Activate a separate Test wallet with
its dedicated synced passkey before creating a checkout. The paying wallet needs Tidepool test
tokens and test network gas. Test tokens have no monetary value. Extra Test wallet keys, recovery
kits, gasless sponsorship and HOOK delivery are unavailable. See the
[Test payment guide](https://docs.usetendr.tech/testing).

#### Local simulator

The following simulation controls apply only to development deployments configured with
`TEST_PAYMENT_PROVIDER=simulated`, not hosted Tidepool Test mode.
Local Test keys use a simulated 1Click and the mock intents verifier. No real swap runs.
Settlement credits the store's test account through the mock verifier: in memory with the fake NEAR
driver, on testnet with the rpc driver (any deployed environment). The simulator's settlement
transaction is synthetic, so test mode verifies it through the simulator; live mode only ever
accepts a transfer the chain reports.

A test session's checkout page shows a test panel. The shopper API offers the same: once a quote
exists, call `POST /v1/checkout/client/simulate` with `Authorization: Bearer <client_secret>` and
`{ "scenario": "..." }`.

| Scenario   | What happens                                                          |
| ---------- | --------------------------------------------------------------------- |
| `exact`    | The quoted amount arrives and settles                                 |
| `overpay`  | It settles, and the extra is returned (or kept if under $1, below)    |
| `underpay` | Part arrives, and 1Click reports an incomplete deposit                |
| `topup`    | After `underpay`, the rest arrives before the deadline and it settles |
| `late`     | A deposit arrives after the quote expired                             |
| `failed`   | 1Click reports that the swap failed                                   |

- Add `"sender_address"` to simulate a deposit from that address.
- An address in `SCREENING_TEST_BLOCKLIST` (default `0x000000000000000000000000000000000000dead`)
  counts as a sanctioned sender, and the payment is held.
- The route answers `404` for a live session.

### Who pays fees and gas

- **Fees.**
  - `fee_payer: merchant` is the default. The shopper pays exactly the order total. Tendr's fee,
    1Click's fee and the swap spread come out of what the store receives.
  - `fee_payer: shopper`: the store receives the order total, and the shopper's amount grows by
    the fees, shown on the quote screen.
- **Gas.**
  - `gas_payer: shopper` is the default: the shopper pays the network fee, in the token they send
    or in the chain's coin.
  - `gas_payer: merchant`: Tendr sponsors the fee within the store's gas policy and takes it from
    what the store receives for that payment. A payment that fails the policy falls back to
    shopper-pays. See [Gasless payments](#gasless-payments).
- **Resolution.** Each setting is resolved once, when the session is created. The order is:
  1. the session's own `fee_payer` / `gas_payer`;
  2. the payment link's setting (`fee_payer` / `gas_payer`);
  3. the store default.

  Set store defaults under Settings → Checkout, or with `default_fee_payer` / `default_gas_payer`
  in `PATCH /v1/settings/checkout`. The defaults apply to test and live: there is one setting per
  store, so a change made with a test key or in test mode changes live checkouts too.

- **Tendr's fee** is the store's fee plan, in basis points. It is 50 bps without a plan, and a
  plan may set 0. It is a 1Click `appFees` entry paid to Tendr's fee account, never taken from the
  store's account.

### Gasless payments

A shopper holding a token can pay without the chain's gas coin. The shopper signs a payload bound to
the deposit address, the amounts, the fee recipient and a deadline; the relayer submits it and pays
gas. Submitting never marks a payment paid: the watcher does. Docs: `apps/docs/gasless/`,
`apps/docs/integrations/hooks.mdx`. Handover note for the dashboard:
`docs/handover/2026-10-27-gasless-relayer.md`.

- **Who pays.** The store sponsors (`gas_payer: merchant`) within its gas policy (`GET`/`PUT
  /v1/gas-policy`), or the shopper pays the fee from the token they send, or in the chain's coin.
  Defaults: $1 per payment, $50 per month, every chain except Ethereum mainnet, off until enabled. The
  fee is the live network fee plus `GAS_FEE_MARGIN_BPS` (default 2000), and a sponsored fee plus any
  hook estimate over 1 % of the order falls back to shopper-pays.
- **Methods.** EVM: EIP-3009 or EIP-2612 permit through the TendrForwarder, or Pimlico sponsored
  calls for Safe smart wallets. Solana: Pimlico Kora (sponsorship only reaches orders of roughly $34
  and up, because of the new token account's rent). Tron: two signatures through the Tron forwarder,
  about $15, so shopper-paid by default. NEAR: meta-transactions, which need a wallet that signs
  delegate actions (Meteor and Intear do not yet). Copy-address payments are never gasless.
- **Integrator hooks.** `hook_data` on a session of an integrator store makes it call
  `onTendrDeposit` (EVM) or `on_tendr_deposit` (NEAR) on the settlement contract once the payment is
  settled. Retried for 3 days, then `hook.failed` and one email; `POST /v1/payments/:id/hook/resend`
  afterwards (at most 3 resends per hook call). `GET /v1/relayers` (public) publishes the address
  that calls the hook on each chain. Hook gas comes out of the payment's proceeds (hook alone capped at 10 % of the order).
  Reference contracts: `onchain/evm/src/reference/TendrDepositReceiver.sol`, `onchain/integrator-near`.
- **Jobs.** `release-gas-reservations` (60 s), `poll-evm-relays` (15 s), `deliver-hook` and
  `sweep-hooks`, `fee-sweep` (hourly) and `check-gas-balances` (15 min). The last two run only when
  `NODE_ENV=production`.

**Live checklist (gasless payments).** Nothing below is done: no contract is deployed, no live Pimlico
account is used and the sweep is off. The per-chain detail is in the
[manual checklist](#mainnet-checks-for-checkout); this list is the order to work in.

1. Apply the migrations to the development database
   (`npm run db:migrate:dev --workspace=@tendr/api`; the live database gets `db:migrate` at deploy).
2. Create the Pimlico account and a sponsorship policy; store the API key with
   `putSecret(key, 'pimlico')` and set `PIMLICO_SPONSORSHIP_POLICY_ID` (and `PIMLICO_SOLANA_NETWORK`).
   Pimlico has no balance API, so fund it and watch the balance in the Pimlico dashboard by hand: its balance reader
   returns "unknown", so `gas.pimlico_balance_low` never fires yet.
3. Have the TendrForwarder (EVM and Tron) externally reviewed, then deploy it
   (`onchain/evm/README.md`; nothing runs the deploy script for you). Set `EVM_FORWARDER_ADDRESS` and
   `TRON_FORWARDER_ADDRESS` (Tron gasless is off while it is unset).
4. Create the KMS keys `relayer-evm`, `relayer-near`, `gas-tron` and the receive-only `gas-fees-evm`,
   `gas-fees-tron`, `gas-fees-near`, `gas-fees-solana`. Fund the relayer keys with working gas, and give
   each gas-fee account a trace of native coin for its sweep transfers. Alerts fire below
   `GAS_LOW_BALANCE_USD` (default $50).
5. Set `TENDR_FEE_ACCOUNT_NEAR`. The sweep does nothing while it is unset.
6. Set per-chain `EVM_MAX_FEE_GWEI_<CHAIN>` caps for the EVM relayer and the sweep. Without them the
   relayer uses the chain's own fee and the sweep uses its defaults in gwei: eth 100, base 5, arb 5,
   op 5, pol 1000, bsc 10, avax 100, gnosis 50, bera 50
   (`apps/api/src/jobs/fee-sweep-guard.ts`).
7. Leave `FEE_SWEEP_ENABLED` at its default `false` until step 8 passes. While it is false, due sweeps
   are planned and operators are told what waits; no gas-fee key signs anything.
8. Run one small live sweep per chain family (EVM, Solana, NEAR, Tron), then set
   `FEE_SWEEP_ENABLED=true`. Check the `fee_sweeps` row and the USDC arriving.
9. Confirm with 1Click that an EXACT_INPUT quote from USDC on NEAR to USDC on NEAR works for the
   sweep, and that it charges `appFees` on the output (`ONECLICK_APP_FEE_BASE`) before live sponsorship.
10. Measure the NEAR hook call's gas on chain against `HOOK_GAS_UNITS.near` (30 Tgas) in
    `apps/api/src/gas/fees.ts`, and the Tron energy against `TRON_ENERGY_UNITS`. Ask 1Click whether
    NEAR delivery can carry a message (`ft_transfer_call`): if so, NEAR integrators can use an atomic
    notification and drop the relayer from the trust path.
11. Check `GET /v1/relayers` on the live API returns the live `relayer-evm` address on each EVM hook
    chain and the `relayer-near` account (it derives them from the KMS public keys), point
    integrators at it, and tell them about the misattribution limit in
    `apps/docs/integrations/hooks.mdx`.
12. Route `gas_ops` system events and `OPS ALERT` log lines to the on-call channel. The sweep and
    balance jobs are scheduled only with `NODE_ENV=production`.
13. Sponsored live payments wait for the contract review and the checks above. Keep
    `GASLESS_LIVE_ENABLED` at its default `false` until then: while it is false, live checkouts offer
    no gasless option, live quotes have no sponsored path and every live relayer path answers
    "gasless not available". Set it to `true` only after this list is done (and live mode itself is
    open, `LIVE_MODE_ENABLED=true`). Local simulator mode can exercise these paths; hosted
    Tidepool Test mode does not offer gasless sponsorship or HOOK delivery.
14. Run the Mintlify CLI broken-links check on the docs before publishing them
    (`cd apps/docs && npx --yes mintlify@4.2.83 broken-links`). It timed out in Docker during the
    build; only a scripted nav and link check was run.

### Returns: the return fee and the under-$1 rule

- **Direct returns.** A connected wallet, or a refund address the shopper typed on the quote
  screen, becomes 1Click's refund address. Underpayments, overpaid extra and late deposits go back
  to it directly.
- **Returns through the store.** Without such an address, 1Click returns the money to the store's
  merchant account. Tendr drafts a refund proposal, and a signer approves it (project 2).
  - The cross-chain fee of sending it back is deducted from the amount returned.
  - If what is left is worth under $1, it is not returned. The store keeps it as a small
    overpayment, no signer is needed, and the payment and webhook show
    `kept_small_overpayment: true`.
  - The checkout tells the shopper about the under-$1 rule before they pay.
- **Exchange senders.** A sender that is a known exchange address is not refunded blindly. The
  refund waits for an address (`refund.needs_address`), and the shopper is asked for one by email
  or on the checkout.

### Sanctions holds

With `SCREENING_MODE=chainalysis` (the default), Chainalysis screens live senders, connected
wallets, refund addresses and native payout destinations. The key is the secret with purpose
`chainalysis` or the `CHAINALYSIS_API_KEY` environment fallback. A hit holds the payment:

- the order stays unpaid;
- `payment.held` is sent instead of `payment.succeeded`;
- every signer gets this notice:

> These funds came from a sanctioned address. Tendr cannot freeze them; you are responsible for not using them; get legal advice.

Tendr is non-custodial, so a hold is a notice, not a freeze. Money already swapped into the store's
account is in the store's control.

- A held payment is never settled or refunded automatically.
- There is no "release to merchant" action.
- The only way out is a refund through a signer-approved proposal. Before it, an owner must type
  the legal-clearance acknowledgement, `I have legal clearance to refund this payment`.
- If screening is unavailable, the payment waits in `SCREENING_PENDING` and screening is retried
  for up to 6 hours. After that it becomes a review item, not a hold.

The hackathon deployment explicitly uses `SCREENING_MODE=disabled` on both API and worker.
Live payments, refunds and payouts then proceed without Chainalysis or a screening key, with
`*.screening_skipped` / `merchant_account.payout_screening_skipped` audit events instead of
provider approvals. Receipt verification, address validation, passkey authorization and existing
holds still apply. Test-mode screening fixtures are unchanged. Re-enable with a working provider
and `SCREENING_MODE=chainalysis` on both services; completed payments are not retroactively checked.

### Tendr's fee account

`FEE_ACCOUNT_LIVE` and `FEE_ACCOUNT_TEST` receive the `appFees`. They default to
`fees.tendr.near` and `fees.tendr.testnet`. Each is a project 2 merchant account (the passkey
threshold contract) whose signers are Tendr's operators, so Tendr's revenue has the same
protection as stores' money. Local simulator mode credits simulated fees through the mock verifier.
Tidepool Test quotes do not charge Tendr application fees; provider and network costs can still apply.

`fees` (and every label under Tendr's parents that env names, plus a static list and the
`gas-*`, `fee-*`, `fees-*`, `intents*` and `tendr*` prefixes) is a reserved store label
(`apps/api/src/merchants/reserved-labels.ts`). A store named "Fees" gets `store-fees`, and no
store's account may ever be `fees.tendr.*`. Provisioning won't adopt an existing account unless one
of its on-chain signers is a signer of that store. Signup therefore can't provision the fee
account; it needs an operator-only path (not built yet).

### Mainnet checks for checkout

This is a manual script. It spends real funds, capped at 5 USD, and CI never runs it. It checks
the spec's "Assumptions to verify early" with a funded mainnet account of your own. That account
plays the merchant: every payment is delivered and refunded to its own intents balance.

```bash
export VERIFY_FUNDER_ACCOUNT_ID=you.near VERIFY_FUNDER_PRIVATE_KEY=ed25519:...
export ONECLICK_API_KEY=<1Click JWT> VERIFY_CHAINALYSIS_API_KEY=<key>
npm run checkout:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds
npm run checkout:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds --phase cleanup
```

The account needs about 0.2 NEAR and 4 USDT on NEAR. By default each payment sends USDT on NEAR,
delivers 1 USDC on NEAR, and pays 50 bps to `fees.tendr.near`. The flags that change this are
listed at the top of `apps/api/scripts/verify-checkout-mainnet.ts`.

Before it pays anything, it:

- checks the Chainalysis key: a known sanctioned address is identified, and a clean one is not;
- prints a raw dry quote, parsed by the API's own 1Click client;
- checks that your account is registered on the destination token, which cleanup needs to
  withdraw the delivered USDC. If it is not, registering it (at most 0.0125 NEAR) goes into the
  plan and is paid after you confirm. If it would cost more, the script refuses and prints the
  `storage_deposit` call to make yourself;
- prints the plan with every cost (in integer micro-USD), and refuses a plan over 5 USD;
- asks you to type `spend`.

Then it pays four times:

1. **Overpay.** An `EXACT_OUTPUT` payment, overpaid by 25%.
   - The recipient must be credited exactly `amount_out`, no more and no less, found the way the
     watcher finds it: in the settlement transaction's receipts.
   - The excess must reach `refundTo`.
   - It prints the settlement receipts and events, and which account routes `tx_status` to them.
   - The `appFees` share must reach the fee account. This is a balance delta on the fee account,
     so run the script only before live fees flow to it (or pass your own `--fee-account`).
   - It prints the raw 1Click status, the origin transaction and the sender.
2. **Extra deposit after settlement.** A tenth of the payment, sent to the overpay's deposit
   address after it settled. INFO only, since the spec defines no required outcome. It prints
   `depositedAmount` before and after, whether the new origin hash is listed, and whether the
   extra was refunded or swapped to the recipient. The watcher's late and seen-hash handling must
   match what it prints.
3. **Underpay and top up.** It sends half a payment, then the rest to the same address before the
   deadline.
   - PASS only when 1Click reported `INCOMPLETE_DEPOSIT` before the top-up, and the accumulated
     deposit then settled. Then `CHECKOUT_TOPUP_ENABLED=true` is safe in live. Top-ups stay off
     in live until then.
   - INCONCLUSIVE when the underpay was never reported (both halves may have counted as one
     deposit). The top-up is still sent; keep `CHECKOUT_TOPUP_ENABLED` unset.
   - FAIL when 1Click refunded instead of accumulating.
   - It prints `depositedAmount` against the origin transaction hashes 1Click lists.
4. **Late deposit.** It sends a deposit after the quote's deadline, and prints whether 1Click
   refunded or swapped it.

It stops at the first FAIL. A first FAIL may be a wrong guess about the 1Click wire format, so read
the printed response. `--phase cleanup` asks you to type `withdraw`, then withdraws your intents
balances of both assets back to your account. What is spent for good: gas, storage deposits, the
fee share, 1Click's fee and the spread.

**Manual checklist (not scripted):**

- Set a real `NEXT_PUBLIC_REOWN_PROJECT_ID`, with the checkout origin allowed in Reown.
- On a registered store page, in both the modal and the widget, pay with a real wallet of each
  family: EVM, Solana and Bitcoin (Reown AppKit), Tron (TronLink) and NEAR (Wallet Selector).
- Where a wallet is blocked inside the frame, check the popup fallback round trip: the wallet step
  opens in a popup, the payment goes through, and the frame shows the result.
- Pay in wNEAR from a NEAR wallet that holds only NEAR. The checkout wraps the shortfall first.
- Pay Tron USDT through TronLink.
- Confirm 1Click's EXACT_OUTPUT `amountIn` / `minAmountIn` and excess-refund semantics (a
  sponsored shopper-pays quote sends the dry EXACT_OUTPUT `minAmountIn` as EXACT_INPUT).
- Confirm 1Click charges appFees on the output (ONECLICK_APP_FEE_BASE) before enabling live gas
  sponsorship.
- EVM gasless relayer, before live use: the TendrForwarder is deployed at `EVM_FORWARDER_ADDRESS`
  on each chain; `relayer-evm` holds working gas there; each allow-listed token
  (`apps/api/src/relayer/evm/tokens.ts`) returns the listed EIP-712 `name()` / `version()` on
  chain; `EVM_RPC_URLS` points at endpoints that accept `eth_sendRawTransaction`. Then relay one
  EIP-3009 and one permit payment of a few cents per chain and check the watcher (not the relay)
  marks it paid.
- Pimlico paymaster proxy (smart wallets), before live use: store the API key with
  `putSecret(key, 'pimlico')` (never an env var); set `PIMLICO_SPONSORSHIP_POLICY_ID` if a policy
  is used; fund the Pimlico balance; confirm Pimlico serves EntryPoint v0.8 on each chain (v0.7 is
  assumed) and that Safe's MultiSendCallOnly is deployed at the addresses in
  `apps/api/src/relayer/evm/user-op.ts`. Confirm every address and runtime in
  `apps/api/src/relayer/evm/known-accounts.ts` on each chain: the Coinbase Smart Wallet
  implementation and factory (and which EntryPoint that implementation accepts: v1 is v0.6-only,
  which this proxy refuses), the Solady ERC-1967 proxy runtime the factory deploys, the SafeProxy
  runtime prefix, the Safe singletons, the Safe 4337 module and the Safe fallback-handler slot. Confirm Pimlico's
  `pm_getPaymasterData` `paymasterData` layout (`mode | validUntil | validAfter | signature`) and
  that its `validUntil` stays within the quote deadline + 1 h (otherwise every sponsorship is
  refused), and whether `pm_getPaymasterStubData` ever returns `isFinal: true` (the proxy forces
  `false`). `API_BASE_URL` must be the public API origin (the paymaster URL is built from it).
  Confirm how far back Pimlico's `eth_getUserOperationReceipt` searches on each chain: the poll
  job must not be down longer than that lookback before an operation's `validUntil` + 2 min, or a
  landed operation reads as "not seen" and is failed with its cost unrecorded. Track the refusal
  rate of the fee bound (`maxFeePerGas` / `maxPriorityFeePerGas` ≤ 2 × `eth_gasPrice`) per chain:
  EIP-1559 wallets that set `2 × baseFee + tip` may exceed it when the base fee rises; raise
  `PAYMASTER_GAS_PRICE_MULTIPLIER` if normal wallets are refused. Accepted risk: an account is
  verified when sponsorship is asked for, but its owner can change it (a Safe's singleton, fallback
  handler or modules; a Coinbase implementation) before the signed operation lands; an operation
  that then moves nothing is recognised as Tendr's loss and bounded by the daily loss cap
  (`TENDR_SPONSOR_LOSS_CAP_USD`).
  Then pay a few cents per chain from a Safe (and a Coinbase Smart Wallet once a v0.7 version is
  listed) through `wallet_sendCalls` with the paymaster capability and check the watcher marks it
  paid and the poll job records the user operation's cost.
- Solana gasless (Pimlico Kora), before live use: the `pimlico` secret works on
  `https://solana.pimlico.io/v1/{PIMLICO_SOLANA_NETWORK}/rpc`; fund the Pimlico balance (it pays
  every Solana fee and the new deposit token account's rent, ~0.00204 SOL, in both fee modes).
  Confirm each entry of `apps/api/src/relayer/solana-tx.ts` `SOLANA_GASLESS_TOKENS` against the
  1Click token list (asset id ↔ `contractAddress` = the mint, SPL Token program, decimals). Confirm
  Pimlico accepts our transaction shape: the paymaster as rent payer of idempotent associated token
  account creates, our compute-unit limit and price (≤ 200 000 CU, ≤ 1 000 000 µlamports/CU), no
  payment instruction (Tendr-sponsored), and that Pimlico serves Kora `signTransaction` (sign
  only; Tendr broadcasts) and never sends what it signs. Check whether Pimlico uses one fee payer
  or a pool (the fee payer is recorded per prepared blockhash; a pool that signs with another key
  than `getPayerSigner` returned makes every submit fail). Create the `gas-fees-solana` USDC/USDT
  token accounts once before go-live (their one-time rent is in no quote). `SOLANA_RPC_URL` must
  serve `sendTransaction` (with preflight), `getSignatureStatuses` with history,
  `getTransaction`, `isBlockhashValid` and `getMultipleAccounts`. Then pay a few cents of USDC from Phantom
  and Solflare, merchant-sponsored and shopper-paid, and check the watcher marks it paid, the poll
  job records the SOL cost, and the fee lands in the `gas-fees-solana` token account.
- NEAR gasless (NEP-366 meta-transactions, `relayer-near`), before live use: fund the
  `relayer-near` implicit account (hex of its public key) with working NEAR; it pays every
  meta-transaction's gas and the 0.00125 NEAR `storage_deposit` that registers each new deposit
  address (and, once per token, the `gas-fees-near` implicit account) on the token, sent at
  submit after the signed delegate passed every check (prepare never spends). Confirm
  `apps/api/src/near/tokens.ts` `NEAR_GASLESS_TOKENS` against the 1Click token list: USDC
  `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` and USDT
  `usdt.tether-token.near` (6 decimals, `storage_balance_bounds().min` ≤ 0.01 NEAR, NEP-141
  `ft_transfer` events emitted by the token contract: fee revenue is read from them). Confirm the
  1Click NEAR deposit addresses are plain accounts that `storage_deposit` can register.
  `NEAR_RPC_URL_LIVE` must serve `send_tx`, `EXPERIMENTAL_tx_status` (with `tokens_burnt`), `block`
  and `query` (`view_account`, `view_access_key`, `call_function`). Confirm which wallets sign
  delegate actions (wallet-selector `signDelegateActions`) with a FULL ACCESS key (function-call
  keys are refused) and pass the prepared `block_height_ttl` as `blockHeightTtl`: the wallet adds
  it to its own head at signing, and the issued bound (`max_block_height`, the quote deadline's
  height) leaves 150 blocks (~90 s) of slack for approval time and an optimistic head. That slack
  is not measured yet: time real wallet approvals (Meteor, Intear) against it, and widen it if they
  run close. Then pay a few cents of USDC and USDT from Meteor and Intear, merchant-sponsored and
  shopper-paid, and check the watcher marks it paid, the poll job records the NEAR burnt, and the
  fee lands in `gas-fees-near`.
- Tron gasless (approve + TendrPayment through the forwarder, `gas-tron`), before live use: deploy
  the forwarder on Tron (see `onchain/evm/README.md` § Tron; external review first) and set
  `TRON_FORWARDER_ADDRESS` (no default: Tron gasless is off until it is set). Confirm
  `apps/api/src/relayer/tron.ts` `TRON_GASLESS_TOKENS` against the 1Click token list: USDT
  `nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near` ↔ contract
  `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, 6 decimals. Confirm on Nile, then mainnet: USDT's
  `approve` overwrites a non-zero allowance (no zero-first rule; a re-approve after an abandoned
  quote relies on it) and `transferFrom` returns `true`; the energy of an approve plus a
  `payWithApproval` into a fresh 1Click deposit address (no USDT held yet) against
  `TRON_ENERGY_UNITS` in `apps/api/src/gas/fees.ts` (235k, +65k for a shopper-paid fee leg) and
  re-tune it; that `triggerconstantcontract` reports a reverting approve as `transaction.ret[0]
= FAILED` or a `result.code`/`message` (energy is never lent for one); that
  `getaccountresource` `EnergyUsed` rises by what the receiver spends of lent energy (the cost
  model measures consumption from it), and how much `EnergyUsed` has already decayed (it recovers
  over 24 h) when it is read before the reclaim: a decayed reading understates use, which is why an
  approve without a SUCCESS receipt books all the energy it was lent; the approve's energy estimate
  (`triggerconstantcontract`) is ≤ 100 000; a delegation with `lock = false` can be undelegated at
  once (the energy job reclaims as soon as the approve's outcome is final, at most 10 minutes
  after it was made); undelegating after the shopper used delegated energy moves that usage to
  `gas-tron` (the cost model counts it). Stake TRX on `gas-tron` for energy (it lends up to
  ~50 000 TRX of staked energy per approve and pays `payWithApproval`, fee limit 100 TRX) and for
  bandwidth (its own delegate / undelegate / payWithApproval transactions; burned TRX is recorded
  as cost). Confirm TronLink (and any other wallet offered) signs the prepared approve exactly as
  given (`trx.sign` on `transaction`, whose `raw_data` JSON must re-serialise to `raw_data_hex`)
  and signs the TIP-712 `TendrPayment` with the forwarder domain (chain id 728126428, the
  forwarder's 20-byte hex address) so that the forwarder recovers the shopper. `TRON_RPC_URL`
  must serve `wallet/getnowblock`, `walletsolidity/getnowblock`, `getaccount`,
  `getaccountresource`, `getcandelegatedmaxsize`, `getdelegatedresourcev2`,
  `triggerconstantcontract`, `getchainparameters`, `broadcasthex` and
  `wallet[solidity]/gettransactioninfobyid` (with receipts and logs). Then pay a few cents of USDT
  from TronLink, merchant-sponsored and shopper-paid, and check: one delegation and one reclaim per
  approve in `tron_delegations`, the watcher marks the payment paid, the poll job records the
  cost, and the fee lands at the `gas-fees-tron` address.
- Gas-fee sweep (`apps/api/src/jobs/fee-sweep.ts`, hourly, live mode only), before enabling
  `FEE_SWEEP_ENABLED=true`: set `TENDR_FEE_ACCOUNT_NEAR` (the account receiving the USDC on NEAR;
  nothing executes while it is unset). Each gas-fee account is receive-only and holds no native
  gas: fund each one an operator-approved trace of native coin for its sweep transfers
  (`gas-fees-evm` ETH/POL/AVAX on each chain, `gas-fees-solana` SOL incl. ~0.00204 SOL rent when a
  deposit token account is new, `gas-fees-near` NEAR, `gas-fees-tron` ~30 TRX of energy); a token
  sweep without it waits as `needs_gas` and operators are told every 6 h. An EVM native balance
  (shopper fees paid in the coin) is swept only once its excess is worth $20, and only the excess
  above a reserve of 3 token sweeps (400k gas each) plus its own transfer at the chain's fee cap
  (`EVM_MAX_FEE_GWEI_<CHAIN>`, else the sweep's defaults in `fee-sweep-guard.ts`), so a top-up
  of at least that reserve stays as gas. The guard refuses any sweep paying more per gas than
  that cap. A sweep is refused when the 1Click quote pays under 95 % of its value after slippage.
  Confirm with 1Click: an EXACT_INPUT quote from each swept asset (incl. USDC on NEAR to the same
  asset) to USDC on NEAR with `recipientType: DESTINATION_CHAIN` into a NEAR account, refunds to
  the origin address; that a NEP-141 `ft_transfer` to a NEAR deposit address (registered by
  `relayer-near`) is detected. Then run one sweep per family with small balances and check the
  `fee_sweeps` row (quote id, deposit address, tx hash) and the USDC arriving.
- Gas balance alerts (`apps/api/src/jobs/gas-alerts.ts`, every 15 min): `relayer-evm` per EVM
  chain with an RPC, `gas-tron` (while the forwarder is set) and `relayer-near` below
  `GAS_LOW_BALANCE_USD` (default $50) alert operators (`gas.relayer_balance_low` event + `OPS ALERT`
  log, once per 6 h per account). Pimlico documents no balance API: its reader returns "unknown"
  until one is confirmed, so watch the Pimlico dashboard by hand. Route the `gas_ops` system events
  and `OPS ALERT` log lines to the on-call channel.

**Live checklist (FX for non-USD stores):** the live FX provider is
[Open Exchange Rates](https://openexchangerates.org) (`FX_PROVIDER=openexchangerates`,
`FX_API_KEY` = its app id), called over HTTPS at `/api/latest.json?symbols=<code>` (USD base, so a
rate is already "1 USD = R <code>"; `asOf` is the response's `timestamp`). Limits to check against
the current price list before going live: the free plan (about 1,000 requests a month, hourly
updates) is fine for wiring and a smoke test, but its hourly timestamps are usually more than
10 minutes old, so most live sessions would get `503 FX_RATE_UNAVAILABLE`. Live needs a plan whose
rates refresh well inside 10 minutes (the Unlimited plan, 5-minute updates, at the time of writing)
and a request quota of at least one call per active currency per minute (the cache is 60 s, so
about 44,000 requests a month per currency in steady use). Then: create one NGN and one EUR live
session and check `fx.source` is `openexchangerates`, `fx.as_of` is under 10 minutes old, and the
USD amount matches `amount / rate` rounded up.

### Known limitations

- **Wallet coverage.** Wallets can pay:
  - native coins listed as `nep141:<chain>.omft.near` for the EVM chains `eth`, `base`, `arb`,
    `op`, `pol`, `bsc`, `avax`, `gnosis` and `bera`, and for Solana, Bitcoin and Tron;
  - PoA-bridged ERC-20 tokens on those chains (`nep141:<chain>-0x….omft.near`);
  - Solana USDC and USDT, and Tron USDT;
  - NEAR tokens (`nep141:`, not bridged).

  These are paid by manual send only (deposit address and QR):
  - HOT-bridged `nep245:` tokens, which include USDT and USDC on BSC and Polygon. So BSC or Polygon
    USDT cannot be paid from a wallet;
  - SPL and TRC-20 tokens other than the verified USDC/USDT above;
  - every other chain 1Click supports;
  - Bitcoin wallets that only sign PSBTs (the shopper is told to send manually);
  - redirect-based NEAR wallets (only the popup wallets Meteor and Intear are offered).

  Without `NEXT_PUBLIC_REOWN_PROJECT_ID`, EVM, Solana and Bitcoin are manual-send only too.

- **`@coinbase/cdp-sdk` is pinned to 1.52.0** (root `overrides`). Version 1.53 and later
  statically import optional `@x402` packages, which breaks the Next build through Reown AppKit's
  optional Coinbase dependency. Check that before lifting the pin.
- Pricing in a currency other than USD or the settlement asset needs an FX source (`FX_PROVIDER`).
  Test mode uses built-in test rates; live mode needs Open Exchange Rates
  (`FX_PROVIDER=openexchangerates` with `FX_API_KEY`), otherwise live non-USD sessions and links get
  `503 FX_RATE_UNAVAILABLE`.
- The 1Click wire format comes from its public docs until the mainnet checks run.
  `apps/api/src/checkout/oneclick/http.ts` is the only place that maps it.
- Underpay top-ups are off in live mode until the mainnet check confirms that 1Click accumulates
  them.

## WooCommerce plugin

`apps/woocommerce/` is the WordPress plugin **tendr: Pay with crypto** (PHP 8.0+, WordPress 6.4+,
WooCommerce 8.5+, GPL-2.0-or-later, text domain `tendr-pay-with-crypto`). Stores install it from
[the WooCommerce guide](https://docs.usetendr.tech/integrations/woocommerce), connect in one click (Connect popup, passkey), and
take crypto payments in the classic and Blocks checkouts. Refunds clicked in WooCommerce become
signer-approved proposals. Everything PHP runs in Docker through `@wordpress/env`; nothing is
installed on the host.

Version 0.2.0 sends the cart's line items with each checkout (exact unit prices, or a "Name × n" line total when the price does not divide evenly; at most 50, and it retries without items if the API rejects them) and the store's brand (name, logo, colours) on connect and on **Refresh brand from my store**, so a merchant can build a theme from their store.

Version 0.3.4 explains Tidepool Test wallet setup and links its faucet. Test purchases check readiness
with the Test credential and use 1.00 USD regardless of store currency. Test and Live readiness
caches are separate; Base and Solana Test transactions link to Base Sepolia and Solana devnet.
Download the ready-to-install ZIP from the guide; no build commands are required for merchants.

| Command (all `--workspace=@tendr/woocommerce`) | What it does                                                    |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `npm run env:start:tests` then `test:php`      | PHPUnit in the tests site (:8891); HTTP is mocked               |
| `npm run lint:php`                             | PHPCS (WordPress + PHPCompatibilityWP 8.0+)                     |
| `npm run env:start`                            | A dev site on :8890 (admin / password) pointed at the local API |
| `npm run build:zip`                            | Builds `dist/tendr-pay-with-crypto-<version>.zip` + `.sha256`   |
| `npm run env:start:e2e`                        | The two e2e sites (:8892 with Plugin Check, :8893)              |
| `npm run plugin-check`                         | WordPress.org Plugin Check on the built zip, in the :8892 site  |

The end-to-end test (`apps/web/e2e/woocommerce.spec.ts`) needs Docker plus the e2e Postgres and
Redis, and runs with `npm run test:e2e:woocommerce --workspace=@tendr/web`. Its global setup builds
the zip and resets both sites. Each site installs the zip through **Plugins → Add New → Upload**,
connects through the popup (sign-up, store, passkey, recovery kit, choose payout, approve), pays in
the Blocks checkout, converts an NGN order, refunds through a signer approval, checks that each site
gets only its own events, re-connects and disconnects (the old keys get 401), and
checks that a guest never sees the method in test mode. WordPress calls the API at
`host.docker.internal:4100`; on Linux set `E2E_API_HOST=0.0.0.0` so the API is reachable there.

**Plugin Check.** `npm run plugin-check` installs the built ZIP into the isolated :8892 site and
runs Plugin Check 2.2.0 with static and runtime checks. It uses the actual
`tendr-pay-with-crypto` slug; no findings are ignored. The review/test environments use WordPress
7.1.4, WooCommerce 11.2.1, and PHP 8.2. Keep testing isolated from the connected Docker demo store.

**Updates.** Version 0.3.2 removes the custom updater. Once approved and released on WordPress.org,
this plugin uses WordPress's standard update mechanism. Until then, install ZIP updates manually.
The website's existing download manifest/update-feed endpoint remains for older pilot versions;
new plugin code does not call it. Build a local review candidate without changing the web download
manifest using `npm run build:zip --workspace=@tendr/woocommerce -- --no-publish`.

**Submission review, 10 November 2026.** This is a local review of the actual ZIP against the
[submission page](https://wordpress.org/plugins/developers/add/),
[18 directory guidelines](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/),
and [common review issues](https://developer.wordpress.org/plugins/wordpress-org/common-issues/).
The signed-in submission page was unavailable to the review tools. WordPress.org makes the final
approval decision; automated checks do not establish full compliance.

| Guideline areas | Package evidence / remaining work |
| --- | --- |
| 1–2: licensing and responsibility | GPL-2.0-or-later declared; GPL text, font OFL notices and asset attribution included. Publisher must have rights to the Tendr branding and service. |
| 3, 14–15: distribution and releases | Custom updater removed; version increased to 0.3.3. SVN release access and future maintenance start after directory approval. |
| 4, 13: readable code and libraries | Shipped PHP/JS is readable. Blocks uses WordPress/WooCommerce libraries; no duplicate React/jQuery or bundled dev dependencies. |
| 5–6, 16: working service | Live/test gateway, order updates and refunds are implemented. Account requirements, charges and the hosted service are documented. Service availability is still a reviewer check. |
| 7: consent and data | Connection is merchant-initiated. Readme now names endpoints, customer email, order keys/details, brand sync, stored metadata and retention. Public policies remain a blocker below. |
| 8: external code | No external plugin updater. Hosted checkout SDK remains a service dependency, explicitly disclosed; service-code exception remains subject to reviewer acceptance. |
| 9, 12, 17: conduct, listing and naming | No affiliate/review incentives, spam or mining found. Five relevant tags, Tendr-first name. Unverified contributor username removed; confirm publisher and final slug before upload. |
| 10: public credits | No site-wide promotional footer/link in the plugin. Payment controls identify the provider; the separate demo-store theme is not shipped. |
| 11: admin experience | Uses WooCommerce settings. Test-mode and configuration notices have resolution actions and clear when resolved. No dashboard takeover or advertising found. |
| 18: directory discretion | Manual review and ongoing publisher conduct remain outside automated verification. |

Reviewed security boundaries include admin capabilities/nonces, Connect state and PKCE, escaped
output, encrypted connection credentials, redacted logs, signed/replay-protected webhooks,
order/session matching, and key-gated read-only order status. Regression tests cover these paths;
this is not a certification of the hosted Tendr service.

**Release blockers:** `https://usetendr.tech/terms` and `https://usetendr.tech/privacy` both returned
HTTP 404 on this review date. Both repository pages, including `origin/deploy`, still contain
local-development/evaluation placeholders. Publish accurate service Terms and Privacy pages
covering the actual operator, contact, data processing, providers and retention, and verify the
readme links before submission. Do not substitute guessed business details or describe the current
candidate as fully approved. The optional Contributors field is omitted until the submitting
WordPress.org username is confirmed; the candidate assumes the slug `tendr-pay-with-crypto`.

**Validation:** Plugin Check static/runtime: zero errors, one performance advisory on
`Tendr_Refunds::remaining()`. That query excludes only the current WooCommerce draft refund,
scoped to one parent order; the exclusion is intentional to prevent double-counting. No finding
is suppressed. PHPUnit: 249 tests / 1,248 assertions pass; six checkout JavaScript regressions pass. PHP coding standards and compatibility checks pass.
The runtime check also passes without the earlier translation-loading notice. The nine removed tests covered the deleted pilot updater.

**Store address changes (0.3.3).** A changed domain, HTTPS scheme or subdirectory requires
**Reconnect to tendr** in the plugin settings so Tendr updates both the checkout allowlist and
webhook destination. Checkout pauses while the saved site address is stale; credentials stay
available for the existing connection-replacement flow. Reconnecting starts in Test mode; check
readiness and select Live again. On an otherwise connected store, an embedded checkout without
a ready/status/complete handshake after 15 seconds falls back to the exact same hosted session.
Closing the modal cancels that timer; a loaded checkout is never timed out. Run its regression
tests with `npm run test:js --workspace=@tendr/woocommerce`.

**Payout.** Connect asks where payments settle (USDC on NEAR by default, or another offered token)
for a new store, and for a picked store that has none. The owner approves the `set_settlement`
proposal with their passkey in the popup. When the store needs more signers, the site still
connects and `GET /v1/connect/status` reports "Add a payout method" until they approve. The same
choice is on the dashboard's **Settings → Payout** page, per mode (live payout is set there when
going live).

**Refunds wait 24 hours by default.** A refund clicked in WooCommerce is a `refund` proposal. The
merchant account timelocks every refund above the asset's daily refund cap, and the cap starts at
0, so every refund waits 24 hours after the signers approve it (any signer can cancel meanwhile),
then goes out and WooCommerce records it. To let refunds go out as soon as they are approved, set a
refund cap on the dashboard's **Security → Refund cap** ("Ask to set the refund cap"); raising the
cap is itself a proposal that takes effect 24 hours after approval.

**Known limits (pilot).**

- **Staging clones.** A copy of a connected site carries the original's site id, so its order
  numbers produce the same `external_ref`s and the API refuses its sessions for orders the
  original also has. Connect a staging copy to a different store (and keep it in test mode).
- **Re-connecting to a different store.** Re-connecting hands the old connection over only within
  the same store. If a site re-connects to another store, its old connection stays live until it
  is removed under **Settings → Connected sites** of the old store.
- **Disconnect while a payment is in flight.** Open sessions without a deposit are closed on
  Disconnect, and pending orders get a note. While the site stays disconnected, WooCommerce's
  hold-stock run cancels those orders; once it re-connects, an order whose payment belongs to the
  earlier connection is kept pending with a note. Check the tendr dashboard for such orders.

**Releasing a version.**

1. Bump the version in `tendr-pay-with-crypto.php` (header and `TENDR_VERSION`), the readme's
   `Stable tag`, its changelog, and `apps/woocommerce/package.json`. `build-zip` refuses a mismatch.
2. Run `npm run build:zip --workspace=@tendr/woocommerce`. It writes the zip to
   `apps/woocommerce/dist/`, copies it to `apps/web/public/downloads/woocommerce/`, and rewrites
   `manifest.json` there (version, file, sha256, requires, tested, requires_php). The zip is
   deterministic: the same source gives the same sha256.
3. Commit `manifest.json` (the zips are gitignored) and deploy the web app with the zip in place.
   The feed (`GET /v1/plugins/woocommerce/update.json`) and the downloads page then offer it. Never
   commit a manifest whose zip is not published with it: stores would be offered a 404.

The committed manifest stays the `0.0.0` placeholder until the first release, so the feed answers
404 and stores see no update.

**Manual live checklist** (not automated; the e2e covers test mode only):

- [ ] Live mode is open: `LIVE_MODE_ENABLED=true` on the api and worker (deploy runbook, "Turning
      live on"). While it is `false`, "Switch to live mode" answers `403 LIVE_MODE_UNAVAILABLE` and
      the plugin stays in test mode, and the live keys Connect issues cannot write.
      `GASLESS_LIVE_ENABLED` stays `false` (live shoppers pay their own network fee) until the
      gasless live checklist is done.
- [ ] On a real https WordPress site with pretty permalinks, install the released zip from
      `https://pay.usetendr.tech/downloads/woocommerce` and check its sha256 against the page.
- [ ] Connect through the popup on app.usetendr.tech; the settings page shows "Connected to …" and
      no key appears anywhere in WP admin.
- [ ] In tendr, finish going live (live account, signers plus recovery key ≥ 2, payout). "Switch to
      live mode" lists what is missing until then, and switches once the store is ready.
- [ ] Pay one small live order in each checkout (Blocks and classic) and check the order note,
      the "You got paid" email and the payout.
- [ ] Refund part of it from WooCommerce: the order stays unrefunded until the signers approve,
      then (at the default refund cap of 0) 24 hours more, then shows the refund.
- [ ] **FX provider for non-USD stores:** live uses Open Exchange Rates (`FX_PROVIDER=openexchangerates`,
      `FX_API_KEY`) on a plan whose rates refresh well inside 10 minutes; see
      [Live checklist (FX for non-USD stores)](#mainnet-checks-for-checkout). Then pay one live
      order on an NGN or EUR store and check the order note's rate, source and time.
- [ ] Publish a newer zip and check that a connected site offers "Update now", installs it, and
      that a tampered zip (wrong sha256) is refused.
- [ ] Disconnect: the site's keys get 401 and the site disappears from Connected sites.

## Scripts

| Script                                                   | Description                                         |
| -------------------------------------------------------- | --------------------------------------------------- |
| `npm run dev`                                            | Web + API + worker (Turbo)                          |
| `npm run dev:docs`                                       | Mintlify docs                                       |
| `npm run build` / `lint` / `typecheck` / `test`          | CI gates (tests need Postgres + Redis)              |
| `npm run test:e2e`                                       | Playwright smoke                                    |
| `npm run db:migrate`                                     | Apply migrations (`prisma migrate deploy`)          |
| `npm run db:seed`                                        | Seed the Demo Merchant                              |
| `npm run jobs:failed --workspace=@tendr/api`             | List failed (dead-letter) jobs                      |
| `npm run checkout:verify:mainnet --workspace=@tendr/api` | Manual mainnet checkout checks (spends up to 5 USD) |

## Deploying

One production environment: `pay.usetendr.tech` (checkout and payment links),
`app.usetendr.tech` (dashboard and WooCommerce connect) and `api.usetendr.tech` on Railway, with
GCP KMS for keys, GCS for theme assets, Resend for mail and DNS at Namecheap. Test mode works there
from the first deploy; live mode stays off behind `LIVE_MODE_ENABLED` until the merchant-account
audit, and live gasless behind `GASLESS_LIVE_ENABLED`.

- Runbook (every outside step, in order, with who does it and how to check it):
  [`docs/handover/2026-10-31-deploy-runbook.md`](docs/handover/2026-10-31-deploy-runbook.md).
- Infrastructure (Terraform stacks, variables, outputs, manual steps):
  [`infra/terraform/README.md`](infra/terraform/README.md). Nothing is applied until the runbook
  says so.

## Product docs

See `docs/product/INTRO_TO_TENDR.md` and `docs/product/TENDR_MONOREPO_SCAFFOLD.md`.

## License

Proprietary / hackathon use unless otherwise stated.
