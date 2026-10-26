# Tendr

**One checkout. Every way to pay.**

Tendr is a universal checkout and payment-orchestration layer for digital commerce. Merchants integrate once; customers pay with supported digital assets; Tendr coordinates checkout, verification, and merchant notifications.

NEAR Intents is an optional execution integration behind the scenes—not the Tendr brand.

> **Status:** checkout core. On top of the foundation (gateway, event log, worker, key vault) and
> the NEAR merchant accounts, stores can create checkout sessions, embed the checkout, take
> payments through 1Click into their merchant account, and receive signed webhooks. Test mode is
> fully simulated. Live mode waits for the mainnet checks and the contract audit described below.

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
Do not set `MERCHANT_ACCOUNT_CODE_HASH_LIVE` (and do not publish a global contract on mainnet) until
the audit is done: provisioning a live account is refused while it is unset.

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
#  "url":"http://localhost:3000/pay/ses_...#cs=ses_..._secret_...",
#  "expires_at":"...","status":"PENDING_DEPOSIT"}
```

- `amount_currency` is `USD` (at most 2 decimals), any ISO 4217 currency code (see below), or
  exactly the store's settlement asset id. Anything else gets `400 UNSUPPORTED_CURRENCY`. The
  settlement asset and destination come from the store's settings, and the request cannot set them.
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
    `503 FX_RATE_UNAVAILABLE`; there is no fallback to a stale rate. Show the shopper "Crypto
    payment is unavailable right now" and offer the store's other payment methods.
  - An `Idempotency-Key` replay returns the stored session; it never fetches a new rate.
  - Test mode always uses the fixed-rate provider (`FX_FIXED_RATES`), whatever `FX_PROVIDER` says.
    Live mode uses `FX_PROVIDER` (`openexchangerates` in production, with `FX_API_KEY`).
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

### Webhooks

Add endpoints in the dashboard (Webhooks) or with `POST /v1/webhooks/endpoints`, for example
`{ "url": "https://...", "events": [...] }`. Omit `events` to receive all of them. The signing
secret (`whsec_...`) is shown once, at creation and on rotation.

- Events:
  - `checkout.session.expired`;
  - `payment.detected`, `payment.processing`, `payment.succeeded`, `payment.refunded`,
    `payment.late`, `payment.held`;
  - `refund.pending`, `refund.sent`, `refund.needs_address`, `refund.cancelled`, `refund.failed`.
- `refund.cancelled` means the refund's proposal was rejected by the signers or expired;
  `refund.failed` means it failed when it executed on chain. Either way no money moved for that
  proposal. `data` has `refund_id`, `payment_id`, `session_id`, `external_ref`, `asset`, `amount`
  (base units of `asset`, as in `refund.sent`), `reason`, and `status` (`cancelled`, `expired` or
  `failed`). Each is sent at most once per proposal, and only once the proposal can no longer
  execute on chain. The return goes back to the review queue, where it can be drafted again.
- `refund.sent` is final. It can follow an earlier `refund.cancelled` or `refund.failed` for the
  same `refund_id`, when the return was drafted again and the new proposal executed.
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

### Test mode

Test keys (`tdr_test_`) use a simulated 1Click and the mock intents verifier. No real swap runs.
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
  - `gas_payer: shopper` is the default: no reduction.
  - `gas_payer: merchant`: the shopper's amount is reduced by the estimated network fee of their
    send, and that comes out of what the store receives. The reduction is capped by the session's
    `gas_max_usd`, else `CHECKOUT_GAS_MAX_USD` (default 2 USD).
- **Resolution.** Each setting is resolved once, when the session is created. The order is:
  1. the session's own `fee_payer` / `gas_payer`;
  2. the payment link's setting (links carry only a gas setting for now);
  3. the store default.

  Set store defaults under Settings → Checkout, or with `default_fee_payer` / `default_gas_payer`
  in `PATCH /v1/settings/checkout`. The defaults apply to test and live: there is one setting per
  store, so a change made with a test key or in test mode changes live checkouts too.

- **Tendr's fee** is the store's fee plan, in basis points. It is 50 bps without a plan, and a
  plan may set 0. It is a 1Click `appFees` entry paid to Tendr's fee account, never taken from the
  store's account.

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

In live mode, Chainalysis screens every sender, connected wallet and typed refund address. The API
key is the secret with purpose `chainalysis`. A hit holds the payment:

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

### Tendr's fee account

`FEE_ACCOUNT_LIVE` and `FEE_ACCOUNT_TEST` receive the `appFees`. They default to
`fees.tendr.near` and `fees.tendr.testnet`. Each is a project 2 merchant account (the passkey
threshold contract) whose signers are Tendr's operators, so Tendr's revenue has the same
protection as stores' money. Test mode credits simulated fees to the testnet account through the
mock verifier.

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
- Pricing currency is USD or the settlement asset only, because there is no FX source yet.
- Payment links carry no fee-payer setting yet.
- The 1Click wire format comes from its public docs until the mainnet checks run.
  `apps/api/src/checkout/oneclick/http.ts` is the only place that maps it.
- Underpay top-ups are off in live mode until the mainnet check confirms that 1Click accumulates
  them.

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

## Deployment

Railway (api, worker, Postgres, Redis) and GCP Cloud KMS are described in
`infra/terraform/` and are **not applied** — see `infra/terraform/README.md`.

## Product docs

See `docs/product/INTRO_TO_TENDR.md` and `docs/product/TENDR_MONOREPO_SCAFFOLD.md`.

## License

Proprietary / hackathon use unless otherwise stated.
