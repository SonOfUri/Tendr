# Tendr Foundation — Design

Date: 2026-10-23
Status: approved
Timing (user's decision): stay the course — build the projects in order with no hackathon shortcut. The NEAR hackathon (Nov 1–14) is not a target.
Source of truth: the four Excalidraw diagrams in the repo root (`checkout-fx-architecture`, `backend-architecture`, `data-model`, `fx-solver-architecture`) and the backend brief that explains how they connect.

## Where this sits

Tendr is being built in full, as the diagrams describe. The work is split into ordered projects, each with its own design:

1. **Foundation** (this document)
2. Checkout core: checkout service, 1Click quotes, fee, screening, payment watcher, refunds, webhooks, hosted checkout screens
3. Merchant accounts: merchant + account services, dashboard login/roles, merchant NEAR account (multi-passkey, multisig + guardian, 72h recovery), allowlist, auto-sweep
4. WooCommerce plugin — **first milestone: a pilot WooCommerce merchant takes a real payment end to end**
5. Gas service, relayer/`onTendrDeposit`, payment links, theme editor, full dashboard
6. JS widget, Shopify app, AI-agent API
7. FX solver (phase 2)

**AI layer** (from the user's brief; added to the backend services layer, not yet on the diagrams). Each lands in the project that owns its surface:

- **Routing recommender** — payer's wallet balances + quotes + gas costs → best token/chain with a short reason; feeds the "Recommended" tag on Choose token. *Project 2.*
- **Payment assistant** — answers payer questions from live session state and refund records only; can explain and look things up, never move funds. *Project 2.*
- **Risk** — extends Screening with suspicious-payer and lookalike-branding detection. *Project 2 (screening) and 5 (branding).*
- **Theme generator** — merchant prompt → theme settings, layout blocks, CSS; passes the same CSS validator as hand-written CSS; saved as a draft for review/publish. *Project 5.*
- **Insights** — aggregates payments and events into conversion and drop-off views. *Project 5.*
- **Agent payments** — agents area: agent identity, budget, per-payment cap, payee allowlist, approval threshold, enforced by Tendr before any session is created for an agent. *Project 6.* Two ways in (user's decision):
  - **Registered agents** — a merchant account sets up agents that pay *other* Tendr merchants. The agent belongs to that merchant account; its limits are enforced before a session is created.
  - **Tendr MCP servers** — any AI agent can use Tendr's MCP tools to pay a merchant on the platform. Without a registered identity it is an ordinary payer: it gets a session and a deposit address and pays from its own wallet, like a human buyer. *(My reading: budget/allowlist/approval rules apply only to registered agents.)*

**Integrator** *(my reading of the diagram, pending the user's correction)*: `merchants.kind = integrator` is a business that receives payments into its own smart contract, notified via the relayer calling `onTendrDeposit` (`delivery = HOOK`), e.g. a game or onchain app. It is a label plus the hook delivery path; it does not act on behalf of other merchants, so no parent/child merchant relation is needed.

What the foundation does for the AI layer: reserves an `agent` principal type in the gateway (implemented in project 6); stores the LLM provider credentials in `KeyVault`; and makes AI services read-only by construction — they get data-access helpers with no write or state-transition methods, so "can't move funds" is enforced in code, not in prompts.

The foundation is everything the later projects stand on: the complete database, the shared state definitions, the API Gateway, the event log, the job queue, secrets/keys, test mode plumbing, and deployment on Railway. It ships no checkout behaviour of its own.

## Intent

Get the platform layer right once so every later service is "write business logic against solid rails", not "also invent auth, idempotency and retries". No rush: correctness and auditability over speed.

## Goals

- The full `data-model` diagram exists as one Prisma schema with a fresh migration.
- Payment states and transitions from the diagrams are defined once, in `@tendr/contracts`, and enforced server-side.
- Every client request goes through one API Gateway that authenticates, scopes, rate-limits and de-duplicates it.
- Every state change is recorded in an append-only event log that the database itself refuses to modify.
- State changes reliably turn into background jobs (no "state changed but merchant never notified").
- Secrets are encrypted by GCP Cloud KMS; signing keys live in Cloud KMS and never leave it.
- Stripe-style test mode: test and live data never mix.
- API, worker, Postgres and Redis deploy on Railway; local dev runs with docker-compose.

## Non-goals (this project)

- Any real checkout flow, 1Click calls, payment watching, webhooks content, refunds — project 2.
- Dashboard login, merchant users, passkeys, NEAR accounts — project 3. (Tables exist; services don't.)
- WooCommerce plugin — project 4.
- The solver database — phase 2, separate DB.

## Anti-goals

- Tendr storing a private key, a merchant full-access key, or a plaintext secret in Postgres.
- Test-mode data reachable with a live key, or vice versa.
- Any path that lets a browser or client move a payment's state.
- An event log that can be edited after the fact.

## Decided by the user

- Replace the existing sandbox slice outright. Follow the diagrams; the current sandbox schema, state names (`CREATED`, `AWAITING_PAYMENT`, `FAILED`, `REFUND_PENDING`), routes, sandbox provider and demo do not need to survive.
- Production hosting: **Railway Pro**.
- KMS: **GCP Cloud KMS**.
- **Stripe-style test mode**: `tdr_test_` / `tdr_live_` keys and a `livemode` flag on records.
- Merchants get their own NEAR account (project 3), not "pay to an existing wallet only".

## The design

### 1. Database schema

One Prisma schema at `apps/api/prisma/schema.prisma`, one new initial migration (old migration deleted — there is no production data). Tables, exactly as the `data-model` diagram names them (snake_case table names via `@@map`, camelCase in TypeScript):

- **Merchant domain:** `merchants`, `merchant_users`, `api_keys`, `account_keys`
- **Configuration:** `settlement_configs`, `payout_allowlist`, `webhook_endpoints`, `gas_policies`
- **Payments core:** `payment_links`, `sessions`, `quotes`, `payments`, `refunds`
- **Delivery, gas & audit:** `webhook_deliveries`, `hook_calls`, `gas_sponsorships`, `screening_results`, `events`
- **Revenue & branding:** `fee_plans`, `revenue_entries`, `checkout_themes`, `theme_assets`

Columns follow the diagram field lists. Rules that apply across tables:

- `merchant_id` FK on every merchant-owned table (diagram note), indexed.
- `livemode boolean not null` on every merchant-owned table that holds transactional or configuration data. Exceptions (shared across modes): `merchants`, `merchant_users`, `account_keys`, `checkout_themes`, `theme_assets`, `fee_plans`. *(My call — Stripe shares account, team and branding across modes; everything with money, keys, endpoints or payments is per-mode.)*
- `account_keys` stores public keys only. No column anywhere holds a private key.
- `webhook_endpoints.secret_ref` points at a KMS-encrypted secret (see §5); no plaintext or hash of the secret is used for signing.
- Enumerated columns (`role`, `kind`, `status`, `payout_mode`, `amount_mode`, `delivery`, `gas_sponsor`, `fee_payer`, refund `reason`, sponsorship `method`, screening `decision`, revenue `source`, theme `status`/`layout`, etc.) use the values shown in the diagram, as Postgres enums.
- `sessions.external_ref` is unique per `(merchant_id, livemode)` — the idempotent order reference.
- `api_keys` additionally carries `livemode` (derived from key prefix) and `scopes[]`.
- **Cross-merchant links are rejected by the database (user's review).** Every FK between merchant-owned tables is a composite FK that includes `merchant_id`, plus `livemode` when both tables have it (e.g. `sessions(theme_id, merchant_id) → checkout_themes(id, merchant_id)`, `sessions(payment_link_id, merchant_id, livemode) → payment_links(id, merchant_id, livemode)`). A session cannot point at another merchant's theme or link, or at a link from the other mode.
- **Slugs (user's review):** `merchants.slug` is unique (the merchant handle in `/pay/<merchant>/<link>`); `payment_links.slug` is unique per `(merchant_id, livemode)`.
- **Gas sponsorship via Pimlico (user's decision):** EVM gas sponsorship uses Pimlico (ERC-4337 paymaster/bundler) instead of self-run gas wallets. `gas_sponsorships.method` gains `paymaster_verifying` and `paymaster_erc20`; the table gains `provider` and `user_op_hash`. The Pimlico API key is stored with `putSecret` like other credentials.

Two infrastructure tables not on the diagram, needed by the gateway and event dispatch:

- `idempotency_keys` — `(merchant_id, livemode, key)` unique, request hash, stored response, expiry (24h).
- Whatever the event dispatcher needs to guarantee delivery (see §4). *(Left to the builder; must not modify `events`.)*

**Amounts** *(my call)*: on-chain amounts (`amount_in`, `amount_out`, `amount_received`, `fee_amount`, `network_fee`, revenue `amount`) are stored as `numeric(78,0)` in the asset's smallest unit, with the asset id alongside. USD values (`per_payment_cap_usd`, `monthly_budget_usd`, `min_order_usd`, `gas_max_usd`, `cost_usd`) are `numeric(18,6)`. **Prices carry a currency (user's review):** `sessions` and `payment_links` have `amount` plus `amount_currency` — either `USD` (merchants price as "$49.00"; USD is only a pricing unit, no fiat is touched) or an asset id. `amount` is stored as a decimal in human units of `amount_currency` (`numeric(38,18)`); the conversion to the destination asset's smallest unit happens at quote time and is recorded on the quote. Asset ids are stored as 1Click/NEAR Intents asset identifiers (e.g. `nep141:…`) — exact format verified in project 2.

**IDs** *(my call)*: Stripe-style prefixed string ids (`mer_`, `ses_`, `quo_`, `pay_`, `ref_`, `evt_`, `key_`, `whe_`, …) generated in application code — readable in logs and support tickets and safe to expose in the API. The part after the prefix is a **ULID** (`evt_01J…`), so ids sort by creation time (user's review). Note ULIDs order by generation time, not commit time, so the §4 dispatcher still must not rely on id order alone.

**Seed:** creates one demo merchant with an owner placeholder, test and live keys (printed once), a default test-mode settlement config and a default checkout theme. **Live mode gets no settlement config unless a real payout address is provided** (user's review) — never a zero or placeholder address.

### 2. Shared states — `@tendr/contracts`

Rewrite `packages/contracts` around the diagram:

- Payment/session states: `PENDING_DEPOSIT`, `PROCESSING`, `SETTLED`, `REFUNDED`, `EXPIRED`, `LATE_DEPOSIT`.
- Allowed session transitions:
  - `PENDING_DEPOSIT → PROCESSING | EXPIRED`
  - `PROCESSING → SETTLED | REFUNDED` (refund on underpaid/failed)
  - `EXPIRED → LATE_DEPOSIT` (funds arrived after the session expired)
  - `LATE_DEPOSIT → REFUNDED`
  - `SETTLED`, `REFUNDED` are terminal.
- Refund reasons: `expired | late | underpaid | failed`.
- Zod schemas for every enum above and for the shared error envelope.

**Quote expiry is not session expiry (user's review).** A quote expiring does not change the session: it stays `PENDING_DEPOSIT` and the payer gets a fresh quote. The session moves to `EXPIRED` only when `sessions.expires_at` passes or the merchant cancels it.

**Late deposits never reopen a terminal session (user's review).** Anyone can send funds to an old one-time address at any time. Such deposits are handled at the payment level only:
- to an expired quote while the session is still `PENDING_DEPOSIT` → a `payments` row with `is_late = true` that goes to `REFUNDED`; the session is untouched;
- after the session is `EXPIRED` → the session moves `EXPIRED → LATE_DEPOSIT → REFUNDED` (the diagram's path);
- after the session is `SETTLED` or `REFUNDED` → a new `payments` row with `is_late = true` that goes to `REFUNDED`; the session stays terminal. Project 2 must never try to transition a terminal session.

**Which rows carry which state** *(my call)*:

- `sessions.status` is the state machine above — it is what the checkout screens render from and what `recordEvent` keys on (`aggregate_type = session`).
- A session has many `quotes` (a fresh quote each time one expires) and many `payments` (one per deposit detected). Each payment references the quote whose deposit address received it.
- `payments.status` uses its own enum: `DETECTED → PROCESSING → SETTLED | REFUNDING → REFUNDED`, with `is_late` marking deposits to an expired quote or a terminal session. The session's status is derived from its payments by the watcher (project 2).
- **Refunds visible at session level (user's review):** the session read model exposes `refund_status` = `none | in_progress | refunded` (plus the refund reason), derived from its payments and `refunds`, so the checkout can show "Refund in progress" without reconstructing it. This is a derived field on the API's session view, not an extra state in the machine.
- **Late refunds on a settled session are separate (user's review):** refunds of late deposits on a `SETTLED` session are exposed as `late_refund_status` (same values), not in `refund_status`, so a successful payment's receipt never shows "refunded".
- Status enums the diagram leaves unspecified: `merchants.status` = `active | suspended | closed`; `payout_allowlist.status` = `pending | active | revoked` (pending until `active_from`); `payment_links.status` = `active | inactive | expired`; `refunds.status`, `hook_calls.status`, `gas_sponsorships.status` = `pending | submitted | confirmed | failed`.

Transitions are enforced in one server-side function used by every service; an illegal transition throws and is logged. No API route lets a client set a status.

### 3. API Gateway

A set of Fastify plugins every `/v1` route goes through, in this order:

1. **Request id** — accept/return `x-request-id`.
2. **Authentication** — `Authorization: Bearer tdr_{test|live}_…`. Keys are stored as SHA-256 hash + visible prefix; lookup by hash; revoked keys rejected. The request carries `{ merchantId, apiKeyId, livemode, scopes }`. Every database query in a request is scoped by `merchantId` **and** `livemode` — enforced by a request-scoped data-access helper, not by convention.
3. **Optional request signing (HMAC)** — integrators may additionally send `Tendr-Signature: t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>`. If a key is configured as `signing_required`, unsigned requests are rejected; timestamps older than 5 minutes are rejected. *(My call on what "API keys / HMAC" on the gateway means: server-to-server integrators like the WooCommerce plugin can be made to sign. The signing secret is KMS-encrypted like webhook secrets.)*
4. **Scopes** — each route declares the scope it needs; missing scope → 403.
5. **Rate limits** — stored in Redis (`@fastify/rate-limit` with Redis store). Secret keys and session secrets are limited per credential; **publishable keys per key *and* client IP** (user's review — one publishable key is shared by every browser on a merchant's site). Default limits are the builder's call; returned via standard `RateLimit-*` headers.
6. **Idempotency** — `Idempotency-Key` header on POSTs. Same key + same body → replay stored response. Same key + different body → 409. Keys expire after 24h. Concurrent duplicates: second waits or gets 409, never double-executes. **An `in_progress` key older than 60 seconds can be taken over** (user's review), so a crashed request doesn't lock the key for 24h.

**Principals** *(my call, following Stripe since test mode is Stripe-style)*. The request context is a principal, not just a key:

- `secret_key` — `tdr_{test|live}_…`, server-side only (plugins, merchant backends, AI agents). Full scoped access for one merchant + mode.
- `publishable_key` — `tdr_pk_{test|live}_…`, safe in browsers (JS widget). Can only call endpoints explicitly marked publishable (e.g. create a session from a payment link, read public theme). `api_keys.kind` distinguishes the two.
- `session_client` — a per-session `client_secret` returned when a session is created; the hosted checkout screens use it to read that one session and its quotes and to request a new quote. Read-and-quote only; it can never change payment state.
- `dashboard_user` — a `merchant_users` login (built in project 3). Carries merchant, role, and the mode the user has selected; mode is explicit per request, never "both". The foundation defines this principal type and its scoping; project 3 implements login.

The data-access helper scopes by the principal's `(merchantId, livemode)` in every case. Raw queries (`$queryRaw`, `$executeRaw` and their unsafe variants) are blocked on both the scoped and read-only clients (user's review); only infrastructure code (event dispatch, idempotency, migrations) uses raw SQL, through the unscoped client. Rate limits and idempotency key on the principal (`apiKeyId`, session id, or user id).

Error envelope is kept from the current code: `{ error: { code, message, requestId, details? } }`.

The foundation exposes only `GET /v1/health` (unauthenticated) and `GET /v1/ping` (authenticated; returns merchant id, livemode, scopes) so the gateway can be tested end to end.

### 4. Event log and dispatch

- `events` is append-only: `id, aggregate_type, aggregate_id, type, payload jsonb, created_at` (+ `merchant_id`, `livemode`). A Postgres trigger rejects `UPDATE` and `DELETE`; the app's DB role additionally has no `UPDATE`/`DELETE` grant on it in production.
- Every state change writes its event **in the same transaction** as the change. A helper (`recordEvent(tx, …)`) is the only way to write one.
- A dispatcher in the worker turns new events into queue jobs (webhook delivery, hook calls, etc. — the handlers themselves arrive in later projects). Guarantee: every committed event is dispatched **at least once**; handlers are idempotent on event id. The builder chooses the mechanism, but it must not miss events committed out of id order (concurrent transactions) and must not modify `events`.

### 5. Secrets and keys — `KeyVault`

A small interface in `apps/api` with two implementations: `GcpKeyVault` (production) and `LocalKeyVault` (dev/test, keys from a local file, clearly refuses to run when `NODE_ENV=production`).

- `encrypt(plaintext) → ciphertext` / `decrypt(ciphertext) → plaintext` — envelope encryption with a Cloud KMS symmetric key. Used for webhook signing secrets, gateway signing secrets, 1Click API credentials, sanctions API key. Postgres stores ciphertext; `secret_ref` columns reference it.
- `sign(keyName, payload) → signature` and `publicKey(keyName)` — asymmetric keys created in Cloud KMS that never leave it. **Two curves (user's review):**
  - **Ed25519** — NEAR (and Solana). Returns a 64-byte signature.
  - **secp256k1** — EVM chains and Tron (relayer calling `onTendrDeposit` on integrators' contracts and submitting EIP-3009 transfers). The caller passes the 32-byte digest (keccak256 for EVM, sha256 of `raw_data` — the txID — for Tron; keccak256 is used for Tron only when deriving its address from the public key); the vault returns `r, s, v`, normalising `s` to the low half and computing the recovery id by trying both candidates against the public key, since Cloud KMS returns only a DER signature.
  - Keys use HSM protection where Cloud KMS supports that algorithm at HSM level, otherwise software.
- **Named keys, declared now so later projects don't add unplanned ones:**
  - `relayer-near` (Ed25519) and `relayer-evm` (secp256k1) — notify-only; project 5.
  - `gas-tron` (secp256k1) — Tron gas wallet (energy/bandwidth sponsorship); project 5. The only self-run gas key (user's decision).
  - EVM and Solana gas sponsorship go through Pimlico (user's decision), whose API key is a stored secret, not a signing key. `relayer-evm` also submits EIP-3009 transfers.
  - `funding-near` (Ed25519) — pays storage deposits when creating merchant NEAR accounts; project 3. **Spend-capped**: Cloud KMS cannot limit spending, so the cap is enforced by the account service (per-account and daily limits) and by keeping the account's on-chain balance low with monitored top-ups.
  - `solver-hot` (phase 2) — project 7.
- **Early GCP check (both curves):** against real Cloud KMS, (a) an Ed25519 signature that verifies as a NEAR signature, and (b) a secp256k1 signature over a keccak256 digest that recovers to the EVM address derived from the key's public key. Projects 3, 5 and 7 depend on this; if either fails, stop and raise it.
- Decrypted secrets are cached in memory for a short TTL; never logged.
- Railway → GCP authentication: a GCP service account with only the KMS roles it needs, credentials supplied as a Railway secret variable. *(My call; workload identity federation from Railway can replace it later if available.)*

### 6. Test mode

- Key prefix decides mode. `livemode` is attached to the request and to every row written.
- The foundation only provides the plumbing (columns, scoping, keys, seed). What test mode *simulates* (deposits, settlement, refunds) is designed in project 2, behind a provider seam: `livemode=false` → simulated provider, `livemode=true` → 1Click.
- A test-mode request can never read or write a live row; there is a test that proves it for every table with `livemode`.

### 7. Queue and worker

- Redis + BullMQ. Two processes from the same codebase: `api` (Fastify) and `worker` (BullMQ workers + event dispatcher + scheduled jobs).
- Retries with exponential backoff; failed jobs land in a dead-letter state visible to ops.
- Local: Redis added to `infra/docker/docker-compose.yml` next to Postgres.

### 8. Deployment and ops (Railway)

**Local first (user's decision).** Everything is built and proven working locally (docker-compose Postgres + Redis, `LocalKeyVault`) before anything is deployed. Deployment happens once, later, when the user decides — it is not part of this project's acceptance. Both the GCP and Railway projects already exist; infrastructure (Railway services, GCP key ring, keys, service account and IAM) is written as Terraform when deployment comes. *(My call: the Terraform can be written in this project but is not applied until the user says so.)*

The one exception is the two-curve check in §5: a small script, run from a developer machine against the existing GCP project, that creates test keys and verifies a NEAR-valid Ed25519 signature and an EVM-recoverable secp256k1 signature. It deploys nothing; it is run early because projects 2, 5 and 7 depend on its answer. *(My call.)*

When deployed:

- Railway project with services: `api`, `worker`, `postgres`, `redis`. Private networking between them. Migrations run as the `api` pre-deploy step.
- Environment validated at boot with Zod (extend existing `env.ts`).
- Structured JSON logs with request id and merchant id; metrics/alerts and status page are the builder's call on tooling, but `api` and `worker` must expose health checks Railway can use.
- CI (existing GitHub Actions) runs lint, typecheck, unit tests and integration tests against real Postgres + Redis.

### 9. What gets removed

The sandbox checkout routes, services, providers, old state machine, old schema/migration, and any web demo pages or SDK methods and docs pages that only exist to call them. The `apps/web` and `apps/docs` shells, `packages/ui`, config packages and CI stay and must still build. The SDK keeps its client/webhook-verification skeleton; its endpoint methods are rebuilt in project 2.

## Acceptance

- `docker compose up` + migrate + seed gives a working local stack; `GET /v1/ping` works with the seeded test and live keys.
- Tests prove: auth (valid/revoked/wrong-mode keys), scopes, HMAC signing (valid, wrong, stale), rate limit, idempotency (replay, conflict, concurrent), test/live isolation on every per-mode table, illegal transitions rejected, `events` cannot be updated or deleted, every committed event is dispatched (including concurrent commits), `KeyVault` local round trip.
- A one-off verification, run locally against the existing GCP project: Cloud KMS encrypt/decrypt round trip, an Ed25519 signature that verifies as NEAR, and a secp256k1 signature that recovers to the key's EVM address.
- Tests prove: a quote expiring leaves the session `PENDING_DEPOSIT`; a transition out of `SETTLED`/`REFUNDED` is rejected; the session view's `refund_status` and `late_refund_status` derive correctly; a session cannot reference another merchant's theme or payment link; a stale `in_progress` idempotency key is taken over after 60s; raw queries are rejected on scoped and read-only clients.
- `api` and `worker` run locally as separate processes with health checks. (Railway deploy is a later, separate step.)

## Left to the builder

- Exact Prisma field types where the diagram is silent (string lengths, index choices beyond the ones named).
- Event dispatch mechanism (within the §4 guarantees).
- Rate-limit numbers, BullMQ retry counts, cache TTLs.
- Logging/metrics libraries and alerting tool.
- Fixing the existing CI workflow (it uses `working-directory: Tendr`, but the repo root is already `Tendr`).
- On Railway Postgres, a separate migration/owner role so the app role can lack `UPDATE`/`DELETE` on `events`.
- Package manager reconciliation: root `package.json` declares pnpm but the repo has `package-lock.json` and the README uses npm — pick one and make it consistent.

## Assumptions to verify early

- GCP Cloud KMS supports Ed25519 signing usable for NEAR transactions and secp256k1 signing usable for EVM/Tron (both verified in this project).
- 1Click has no testnet, so test mode must be simulated (affects project 2, not this one).
- Gas sponsorship coverage (project 5): EVM via Pimlico; Solana via Pimlico (per the user, Pimlico now supports Solana — confirm in its docs before designing project 5); Tron via Tendr's own `gas-tron` key (user's decision).

## Amendments made during the build (2026-10-24)

Decisions taken while implementing, superseding the text above where they differ:

- **Gateway order:** per-IP limit (3000/min) → auth + scope (`onRequest`, before the body is read) → per-principal limit → secure JSON parse (raw body kept) → signature check (`preValidation`) → idempotency (`preHandler`). Exactly one proxy hop is trusted for client IP.
- **Publishable keys** are held to their stored scopes as well as to the routes that allow them; seeded publishable keys get `sessions:read`, `sessions:write`, `payment_links:read`.
- **Suspended or closed merchants** cannot authenticate with any credential.
- **Idempotency** is namespaced per principal: unique on `(merchant_id, livemode, principal_ref, key)`.
- **State changes** go through `tenantTransaction(ctx, fn)`; `transitionSession`/`transitionPayment`/`recordEvent` take the same tenant context and never touch another tenant's rows. Scoped clients forbid nested relation writes and `id` changes.
- **Events** are readable (never writable) through scoped and read-only clients; `event_outbox` stays infrastructure-only.
- **Dispatch** only claims outbox rows whose event type has a registered handler; unhandled rows wait (no silent drop). Handlers are registered in one module, `src/jobs/register-handlers.ts`.
- **KMS** location defaults to `us-east4` (HSM keys are not offered in `global`); every Cloud KMS call verifies CRC32C checksums; the local vault is refused in production at boot.
