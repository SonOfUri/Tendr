# Tendr Checkout Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shopper pays a merchant's order in any token on any chain NEAR Intents supports, through a hosted page, modal or widget. The merchant receives their stablecoin in their own merchant account. Signed webhooks tell the store the order is paid, and every edge case (underpay, overpay, late, exchange sender, sanctioned sender) is handled.

**Architecture:**
- **API:** `apps/api` gains a `checkout/` module:
  - a 1Click provider seam (real HTTP client for live, simulated provider for test);
  - a pure quote-pricing module;
  - session and quote routes;
  - a payment watcher job;
  - refund routing into project 2's signer-approved refund proposals;
  - sanctions screening;
  - signed webhooks.
- **Web:** `apps/web` gains one checkout route (`/pay/[sessionId]`), embedded by a dependency-free `tendr.js` script as a modal or widget, plus dashboard screens.

**Tech Stack:**
- Existing: Node 22, Fastify 5, Prisma 6, BullMQ, Next.js 15, Playwright.
- New on the checkout page only: `@reown/appkit` (EVM, Solana, Bitcoin adapters), TronLink via `@tronweb3/tronwallet-adapter-tronlink`, `@near-wallet-selector/core` + modal, `qrcode`.
- Chainalysis sanctions API (HTTP).

**Spec:** `docs/superpowers/specs/2026-10-25-checkout-core-design.md` (approved 2026-10-25), including its "Decided by the user after the builder check" and "Builder-check calls" sections. Background: the foundation and merchant-accounts specs.

## Global Constraints

**Commits:** no `Co-Authored-By: Claude…` trailer or "Generated with Claude Code" line in any commit or PR (user's standing instruction).

**Custody:** Tendr never holds shopper or merchant funds:
- Swaps go through 1Click straight to the merchant account (`recipientType INTENTS`, recipient = the mode's `merchant_accounts.near_account_id`), or to the saved address in `wallet` payout mode.
- Tendr's fee is a 1Click `appFees` entry to `FEE_ACCOUNT_LIVE` / `FEE_ACCOUNT_TEST` (`fees.tendr.near` / `fees.tendr.testnet`).

**When an order counts as paid:** only on server-verified settlement:
- the 1Click status is `SUCCESS`;
- AND the merchant account's intents balance increased by `amount_out`, or the destination transaction hash is confirmed in `wallet` mode.

Browser `postMessage` events never mark anything paid.

**Timers and limits:**

| Item | Value |
|---|---|
| Session lifetime | 30 min (store may shorten via `expires_in`) |
| Quote deadline | now + 12 min, never later than the session's `expires_at` |
| Watcher poll | every 5 s while the shopper's page polls status, every 30 s otherwise; stop after 24 h |
| Webhook retries | exponential backoff, give up after 3 days; manual resend always allowed |
| Default Tendr fee | 50 bps from `fee_plans`; 0 allowed |
| Small-overpayment threshold | returns worth < $1 are kept by the merchant (`kept_small_overpayment`) and need no signer |

**Pricing rules:**
- `amount_currency` must be `USD` or exactly the merchant's settlement asset; anything else gets 400 `UNSUPPORTED_CURRENCY`.
- **Who-pays resolution:** session override → payment-link setting → merchant default. Resolved once and stored on the session.
- **Merchant pays fees:** covers Tendr fee + 1Click fee + spread. The shopper's `amountInUsd` equals the order total (two-step quote). The merchant receives the resulting `amount_out`.
- **Shopper pays fees:** `amount_out` = order total, and `amount_in` grows.
- **Merchant pays gas (reimbursement):** `amount_in` is reduced by the estimated origin-chain send fee, capped by `gas_max_usd`.

**Refunds:**
- **Connected wallet:** `refundTo` = the wallet address (`ORIGIN_CHAIN`); 1Click refunds directly.
- **Manual send:** `refundTo` = the merchant's intents account (`INTENTS`). Returns go through project 2's `refund` proposal (signer-approved). The cross-chain return fee is deducted from the amount returned.
- **Known exchange senders:** held as `needs_address`.

**Sanctions:**
- Screen with Chainalysis at quote time (connected wallet) and on deposit detection (manual send).
- A hit, or an unavailable screening API, puts the payment in `HELD`; it is never settled and never auto-refunded.
- A held payment can only be refunded by a signer-approved proposal plus a typed acknowledgement that legal clearance was obtained. There is no "release to merchant" action.

**Webhooks:**
- Header `Tendr-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`.
- Payload `{ id, type, created, livemode, data }`.
- Event types: exactly the spec §8 list.

**Framing:**
- The checkout may be framed only by the merchant's `checkout_domains` (shared across modes), via CSP `frame-ancestors`.
- `postMessage` goes only to the registered origin that framed it.
- Third-party wallet scripts are allowed on `/pay/*` only, never on `/dashboard/*` signing pages.

**Foundation and project 2 rules still apply:** prefixed ULIDs; `livemode`; composite tenant FKs; scoped clients; `tenantTransaction`; append-only events; error envelope; the gateway principals (`secret_key`, `publishable_key`, `session_client`, `dashboard_user`); CSRF on cookie mutations.

**Test mode** uses the simulated 1Click provider (`livemode=false`) and the mock intents verifier's `deposit`. API and web tests never touch a network.

## Review Focus

1. **A shopper sends to an old quote's deposit address after a new quote was issued.** The money is attributed to that quote. If that quote's deadline passed, the payment is treated as late. Either way it is never lost or double-counted. Test in Task 7.
2. **A shopper pays twice into one session** (two deposits). The order is marked paid once. The second payment is treated as overpay/late and returned (or kept if < $1). Test in Task 7.
3. **A store retries session creation with the same `external_ref`.** The same idempotency key returns the original session; a different key gets 409 `CONFLICT`. Never two live sessions per order. Test in Task 4.
4. **USD amounts with more than 2 decimals, zero or negative amounts, or amounts below 1Click's minimum.** Rejected with clear 400s at session creation, or at quote time for the minimum. Test in Tasks 4 and 3.
5. **The merchant's webhook endpoint is down for hours, then comes back.** Retries continue until 3 days, each delivery keeps the same event id and signature scheme, and a manual resend works after give-up. Test in Task 9.

---

## File Structure

```
packages/contracts/src/
  states.ts                         # Task 1 (HELD, underpay retry transition)
  checkout.ts                       # Task 1 (webhook event types, FeePayer/GasPayer, SMALL_OVERPAY_USD)
apps/api/prisma/                    # Task 1 migration
apps/api/src/checkout/
  oneclick/types.ts                 # Task 2  OneClickProvider interface + DTOs
  oneclick/http.ts                  # Task 2  real client (JWT)
  oneclick/simulated.ts             # Task 2  test-mode provider with scenarios
  oneclick/index.ts                 # Task 2  providerFor(livemode)
  pricing.ts                        # Task 3  pure quote sizing + who-pays
  sessions.ts                       # Task 4  create/get/expire service
  quotes.ts                         # Task 5  quote issuing (shopper)
  screening.ts                      # Task 6  Chainalysis + fail-closed
  watcher.ts                        # Task 7  status polling, classification, settlement
  refunds.ts                        # Task 8  return-to-sender → refund proposals
  exchanges.ts + data/exchange-addresses.json   # Task 8
  webhooks.ts                       # Task 9  sign, deliver, retry, resend
  revenue.ts                        # Task 7  revenue entries
apps/api/src/routes/
  checkout-sessions.ts              # Task 4  (secret key)
  checkout-client.ts                # Task 5  (session_client / publishable)
  webhooks.ts                       # Task 9  (dashboard)
  payments.ts                       # Task 10 (dashboard reads + review actions)
  merchant-settings.ts              # Task 10 (domains, fee/gas defaults)
apps/web/src/
  app/pay/[sessionId]/…             # Task 11 checkout screens
  lib/checkout/{api.ts,status.ts,embed-bridge.ts}   # Task 11
  lib/wallets/{evm.ts,solana.ts,bitcoin.ts,tron.ts,near.ts,index.ts}  # Task 12
  embed/tendr.ts → public/v1/tendr.js   # Task 13 (built by a small esbuild script)
  app/dashboard/{payments,review,webhooks,settings/checkout}/…  # Task 10
  e2e/checkout.spec.ts              # Task 13
apps/api/scripts/verify-checkout-mainnet.ts   # Task 14
```

---

### Task 1: States, schema, shared checkout types

**Files:**
- Modify: `packages/contracts/src/states.ts` (+ test), `apps/api/prisma/schema.prisma`, `apps/api/src/db/models.ts` (if new models), `apps/api/src/lib/ids.ts` (new prefixes if any)
- Create: `packages/contracts/src/checkout.ts` (+ test), migration `apps/api/prisma/migrations/<ts>_checkout_core/`

**Interfaces — Produces:**
- **Session states:** add `HELD`. Transitions:
  - `PENDING_DEPOSIT → PROCESSING | EXPIRED`;
  - `PROCESSING → SETTLED | REFUNDED | HELD | PENDING_DEPOSIT` (the last only for an underpay retry while unexpired);
  - `EXPIRED → LATE_DEPOSIT`;
  - `LATE_DEPOSIT → REFUNDED | HELD`;
  - `HELD → REFUNDED`;
  - `SETTLED` and `REFUNDED` terminal.
- **Payment states:** add `HELD`. Transitions:
  - `DETECTED → PROCESSING | REFUNDING | HELD`;
  - `PROCESSING → SETTLED | REFUNDING | HELD`;
  - `HELD → REFUNDING`;
  - `REFUNDING → REFUNDED`.
- **`checkout.ts` exports:**
  - `WebhookEventTypeValues` = `checkout.session.expired`, `payment.detected`, `payment.processing`, `payment.succeeded`, `payment.refunded`, `payment.late`, `payment.held`, `refund.pending`, `refund.sent`, `refund.needs_address`;
  - `FeePayerValues = ['merchant','shopper']` and `GasPayerValues = ['merchant','shopper']`. The DB enum `FeePayer` keeps `payer` as its storage value; map `shopper ↔ payer` at the API boundary;
  - `SMALL_OVERPAY_USD = 1`, `SESSION_TTL_MS = 30*60_000`, `QUOTE_TTL_MS = 12*60_000`, `WEBHOOK_RETRY_WINDOW_MS = 3*24*3600_000`.
- **Schema:**
  - **sessions:** `success_url`, `cancel_url`, `customer_email` (nullable, lower-cased), `gas_payer` (via the existing `gas_sponsor` resolved enum), `expired_reason` (`timeout` | `canceled`).
  - **payments:** `sender_address`, `sender_chain`, `overpaid_amount Decimal(78,0)?`, `refunded_amount Decimal(78,0)?`, `oneclick_status`, `held_reason` (`sanctions` | `screening_unavailable`), `kept_small_overpayment Boolean default false`, `amount_out Decimal(78,0)?`, `amount_in_usd Decimal(18,6)?`.
  - **merchants:** `checkout_domains String[] default []`, `default_fee_payer FeePayer default merchant`, `default_gas_payer ResolvedGasSponsor default buyer`.
  - **refunds:** `proposal_id` (FK → `account_proposals`, nullable), `destination`, `destination_chain`, `asset_id`, `amount Decimal(78,0)`, `needs_address Boolean default false`, `acknowledged_legal_at DateTime?`; add `RefundReason` values `overpaid`, `sanctions`.
  - **quotes:** `superseded_at DateTime?`, `amount_in_usd Decimal(18,6)?`.

- [ ] **Step 1: Write failing tests:**
  - `states.test.ts`: every new transition allowed; `SETTLED→*` rejected; `HELD→SETTLED` rejected; `PROCESSING→PENDING_DEPOSIT` allowed.
  - `checkout.test.ts`: the event list equals the spec list exactly.
  - Extend `schema.test.ts`: new per-mode columns respect test/live isolation; `refunds.proposal_id` cannot reference another merchant's proposal (composite FK).
- [ ] **Step 2: Run** `npm test --workspace=@tendr/contracts && npm test --workspace=@tendr/api`. Expect FAIL.
- [ ] **Step 3: Implement.** Use `prisma migrate dev --name checkout_core` with hand-written composite-FK SQL as in earlier migrations. Apply to the dev and test DBs.
- [ ] **Step 4: Run** the tests. Expect PASS. Run root typecheck and lint.
- [ ] **Step 5: Commit** `feat: checkout states, schema and shared types`.

---

### Task 2: 1Click provider seam (real + simulated)

**Files:** Create `apps/api/src/checkout/oneclick/{types,http,simulated,index}.ts` (+ tests). Modify `apps/api/src/env.ts`, `turbo.json`, `.env.example`.

**Interfaces — Produces:**
- **`interface OneClickProvider`:**
  - `tokens(): Promise<TokenInfo[]>`
  - `quote(req: QuoteRequest): Promise<QuoteResponse>`
  - `status(depositAddress: string): Promise<StatusResponse>`
  - `submitDeposit(txHash: string, depositAddress: string): Promise<void>`
- **Types**, mirroring the 1Click v0 API fields verbatim (camelCase):
  - `QuoteRequest { dry, swapType: 'EXACT_INPUT'|'EXACT_OUTPUT', slippageTolerance, originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset, amount: string, refundTo, refundType: 'ORIGIN_CHAIN'|'INTENTS', recipient, recipientType: 'INTENTS'|'DESTINATION_CHAIN', deadline: string, appFees?: { recipient: string; fee: number }[] }`
  - `QuoteResponse { quote: { depositAddress?, amountIn, amountInUsd, amountOut, amountOutUsd, minAmountIn?, deadline?, timeWhenInactive? }, correlationId }`
  - `StatusResponse { status: 'KNOWN_DEPOSIT_TX'|'PENDING_DEPOSIT'|'INCOMPLETE_DEPOSIT'|'PROCESSING'|'SUCCESS'|'REFUNDED'|'FAILED', swapDetails: { originChainTxHashes, destinationChainTxHashes, amountIn?, amountOut?, depositedAmount?, refundedAmount?, refundReason? } }`
  - `TokenInfo { assetId, decimals, blockchain, symbol, priceUsd? }`
- **`providerFor(livemode: boolean): OneClickProvider`:** `HttpOneClick` for live (base URL `ONECLICK_BASE_URL`, default `https://1click.chaindefuser.com`; JWT `ONECLICK_API_KEY` as `X-API-Key`), `SimulatedOneClick` for test.
- **`SimulatedOneClick`:** deterministic prices from a fixture table. `simulate(depositAddress, scenario)`, where scenario is `exact` | `underpay` | `overpay` | `late` | `failed`. The simulated settlement calls the mock intents verifier `deposit` through `nearClient(false)` for the merchant's test account. Exposed to tests and to a test-mode-only route in Task 5.
- **Env:** `ONECLICK_BASE_URL`, `ONECLICK_API_KEY` (required when the live provider is used in production), `FEE_ACCOUNT_LIVE`, `FEE_ACCOUNT_TEST`.

- [ ] **Step 1: Write failing tests:**
  - `http.test.ts`, using a fake fetch: request body shape for a quote, the `X-API-Key` header, non-2xx mapped to a typed `OneClickError` with status and code, and timeouts.
  - `simulated.test.ts`: a quote is deterministic; `simulate('overpay')` yields `SUCCESS` with `refundedAmount > 0`; `simulate('late')` after the deadline yields `REFUNDED`; scenarios credit the mock verifier through the fake near client.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): 1Click provider seam with simulated test-mode provider`.

---

### Task 3: Quote pricing (pure)

**Files:** Create `apps/api/src/checkout/pricing.ts` (+ test).

**Interfaces — Produces:**
- `resolvePayers({ sessionOverride, link, merchant }): { feePayer: 'merchant'|'shopper'; gasPayer: 'merchant'|'shopper' }`.
- `buildQuoteRequests(input: PricingInput): { dry: QuoteRequest; real: (dryResult: QuoteResponse) => QuoteRequest }`, where:
  - `PricingInput { orderAmount: Decimal (USD or settlement units), amountCurrency, settlementAsset, settlementDecimals, originAsset, originDecimals, feeBps, feePayer, gasPayer, gasEstimateUsd, gasMaxUsd, recipient, recipientType, refundTo, refundType, deadline, feeAccount }`;
  - the shopper-pays path uses `EXACT_OUTPUT` with `amount` = order total in settlement units;
  - the merchant-pays path uses `EXACT_INPUT`, sized from the dry quote so `amountInUsd ≈ orderUsd − gasReimbursementUsd`. Compute `amountIn = ceil(dryAmountIn × target / dryAmountInUsd)`;
  - `appFees` = `[{ recipient: feeAccount, fee: feeBps }]` when `feeBps > 0`.
- `gasReimbursementUsd(gasPayer, gasEstimateUsd, gasMaxUsd): number`, which returns 0 when the shopper pays gas and `min(estimate, cap)` otherwise.
- `assertWithinMinimum(quote: QuoteResponse, minUsd = 0.5)`, which throws `QUOTE_TOO_SMALL`.

- [ ] **Step 1: Write failing tests:**
  - payer resolution order (session beats link, link beats merchant default);
  - shopper-pays request fields (EXACT_OUTPUT, amount exact, appFees present);
  - merchant-pays sizing hits the order total within 0.1% given fixture dry quotes;
  - gas reimbursement is capped;
  - `feeBps = 0` → no appFees;
  - deadline is never later than the session expiry;
  - tiny orders give `QUOTE_TOO_SMALL` (Review Focus 4).
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): checkout quote pricing and who-pays resolution`.

---

### Task 4: Session API (store side)

**Files:** Create `apps/api/src/checkout/sessions.ts`, `apps/api/src/routes/checkout-sessions.ts` (+ tests). Modify `apps/api/src/app.ts`.

**Interfaces:**
- **Consumes:** Task 1 schema, Task 3 `resolvePayers`; the project 2 settlement mirror (`settlement_configs`) and `merchant_accounts`.
- **Produces:**
  - **`POST /v1/checkout/sessions`** (`secret_key`, scope `sessions:write`, idempotent). Body: `{ amount: string, amount_currency, external_ref, success_url, cancel_url, customer_email?, metadata?, fee_payer?, gas_payer?, payment_link_id?, expires_in? (60–1800 s) }`. Returns 201 `{ id, client_secret, url, expires_at, status }`; `url` = `${CHECKOUT_BASE_URL}/pay/${id}`.
  - **`GET /v1/checkout/sessions/:id`** (`sessions:read`): the full view, including payments, refunds and totals.
  - **`POST /v1/checkout/sessions/:id/expire`** (`sessions:write`): sets `EXPIRED` with `expired_reason: canceled` (only from `PENDING_DEPOSIT`) and emits `checkout.session.expired`.
  - **`createSession(ctx, input)`** and **`sessionView(ctx, id)`**.
- **Rules:**
  - USD amounts allow ≤ 2 decimals and must be > 0; settlement-asset amounts allow ≤ the asset's decimals.
  - `amount_currency` must be `USD` or the settlement asset.
  - The merchant must have an `active` merchant account in that mode and a settlement config.
  - `external_ref` is unique per merchant+mode among non-terminal sessions (409 `CONFLICT`).
  - The client secret uses the foundation's `ses_<ULID>_secret_<32 hex>` format and is stored hashed.
- **Env:** `CHECKOUT_BASE_URL` (default `http://localhost:3000`).

- [ ] **Step 1: Write failing tests:**
  - creates a session with resolved payers;
  - rejects EUR / 3-decimal USD / 0 / negative (Review Focus 4);
  - duplicate `external_ref` with the same idempotency key replays, and with a different key gets 409 (Review Focus 3);
  - no merchant account gives 409 `ACCOUNT_NOT_READY`;
  - expire only from `PENDING_DEPOSIT`;
  - test/live isolation;
  - a publishable key can't create a session.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): checkout session API`.

---

### Task 5: Shopper-side checkout API (quotes, tokens, deposit submit)

**Files:** Create `apps/api/src/checkout/quotes.ts`, `apps/api/src/routes/checkout-client.ts` (+ tests).

**Interfaces:**
- **Consumes:** Tasks 2–4; Task 6 `screenAddress` (land Task 6 first if you prefer; this task stubs it behind an interface until then).
- **Produces** (all authenticated as `session_client` with the session's client secret, CORS allowed for `CHECKOUT_BASE_URL`):
  - **`GET /v1/checkout/client/session`:** the shopper-safe view — merchant name and logo, amount, currency, status, `expires_at`, the current quote, payments with their shopper-facing state, and whether an email is needed. No merchant internals.
  - **`GET /v1/checkout/client/tokens`:** 1Click tokens, cached 5 min, popular first.
  - **`POST /v1/checkout/client/quote`:** `{ origin_asset, refund_address? (connected wallet), refund_chain? }`.
    - Screens `refund_address` first; a hit gives 403 `WALLET_NOT_ALLOWED`.
    - Builds requests via Task 3: `refundTo` is the wallet, or the merchant intents account when absent.
    - Calls dry then real, and stores a `quotes` row (`amount_in`, `amount_out`, `amount_in_usd`, `deposit_address`, `deadline`, `refund_to`). The previous active quote gets `superseded_at`.
    - Returns the deposit address, the exact `amount_in` and the fee lines.
  - **`POST /v1/checkout/client/deposit`:** `{ tx_hash }` → `provider.submitDeposit` for the current quote.
  - **`POST /v1/checkout/client/email`:** `{ email }`, accepted only when the session needs one.
  - **`POST /v1/checkout/client/simulate`:** test mode only (404 in live), `{ scenario }` → `SimulatedOneClick.simulate`.

- [ ] **Step 1: Write failing tests:**
  - the quote supersedes the previous one;
  - the connected wallet is used as refundTo with `ORIGIN_CHAIN`;
  - a manual send uses the merchant intents account with `INTENTS`;
  - a sanctioned connected wallet gets 403 and no 1Click call;
  - no quote after session expiry (409 `SESSION_EXPIRED`);
  - simulate is 404 in live;
  - the client secret for session A can't read session B.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): shopper checkout API (tokens, quotes, deposit submit)`.

---

### Task 6: Sanctions screening

**Files:** Create `apps/api/src/checkout/screening.ts` (+ test). Modify the env and secrets setup.

**Interfaces — Produces:**
- `screenAddress(ctx, { sessionId, address, chain }): Promise<{ decision: 'allow' | 'block' | 'unavailable' }>`. It writes `screening_results` (`provider: 'chainalysis'`).
- Chainalysis sanctions API: `GET https://public.chainalysis.com/api/v1/address/{address}` with header `X-API-Key` (secret purpose `chainalysis`, via `getSecret`). Non-empty `identifications` → `block`.
- Timeout 3 s → `unavailable`. Results are cached 24 h per address in Redis.
- In test mode, a configurable fixture list of blocked addresses is used and there are no HTTP calls.

- [ ] **Step 1: Write failing tests:** allow, block, timeout → unavailable; cache hit makes no second call; test-mode fixture.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): sanctions screening with fail-closed result`.

---

### Task 7: Payment watcher, classification, settlement, revenue

**Files:** Create `apps/api/src/checkout/{watcher,revenue}.ts` (+ tests). Modify `apps/api/src/worker.ts` and `apps/api/src/jobs/register-handlers.ts`.

**Interfaces:**
- **Consumes:**
  - Task 2 provider and Task 6 `screenAddress`;
  - project 2 `getBalances` (or a direct `mt_batch_balance_of` view);
  - the foundation `transitionSession` / `transitionPayment` / `recordEvent`.
- **Produces:**
  - **`pollDeposit(depositAddress)`** (a BullMQ job). Schedule: every 5 s while the client view was read within the last 60 s, else every 30 s, for up to 24 h after quote creation.
  - **`classify(quote, session, status): PaymentOutcome`** (pure), where `PaymentOutcome = settled | underpaid | overpaid | late | failed | pending`:
    - `late` = deposit observed after the quote deadline, or with the session not in `PENDING_DEPOSIT`/`PROCESSING`;
    - `overpaid` = `SUCCESS` with `refundedAmount > 0`.
  - **Settlement verification:** `SUCCESS` → read the merchant account intents balance for the settlement asset, then mark `SETTLED` only if it rose by ≥ `amount_out` since the quote's baseline (stored at quote time). In `wallet` mode, require `destinationChainTxHashes`.
  - **Sender detection** from `originChainTxHashes` (chain read through a minimal per-chain lookup, or 1Click's provided sender if present). The manual-send sender is screened on detection. Block or unavailable → payment `HELD` (`held_reason`), session `HELD`, and `payment.held` is emitted.
  - **Events and webhooks**, written as events (Task 9 delivers): `payment.detected`, `payment.processing`, `payment.succeeded` (with `overpaid_amount`, `kept_small_overpayment`), `payment.refunded` (reason), `payment.late`, `payment.held`.
  - **Underpay with the session still valid** → session back to `PENDING_DEPOSIT`.
  - **`recordRevenue(payment)`:** `revenue_entries` rows for the Tendr fee (`appFees` bps × amountIn), 1Click fee, network fee and gas reimbursement, using the existing `RevenueSource` enum (extend it if a source is missing).

- [ ] **Step 1: Write failing tests** (SimulatedOneClick + fake near client):
  - exact → `SETTLED` + `payment.succeeded`;
  - balance not risen → stays `PROCESSING` (never settled);
  - underpay → refunded + session reopens;
  - overpay ≥ $1 → settled + return-to-sender queued (Task 8 hook called);
  - overpay < $1 → settled + `kept_small_overpayment`;
  - late → `payment.late`, never `succeeded`;
  - deposit to a superseded quote is attributed to it (Review Focus 1);
  - a second payment into a settled session is late/overpay, and the order is paid once (Review Focus 2);
  - sanctioned manual sender → `HELD`;
  - screening unavailable → `HELD`;
  - polling stops after 24 h;
  - revenue rows written.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): payment watcher, settlement verification and revenue`.

---

### Task 8: Returning money to senders

**Files:** Create `apps/api/src/checkout/{refunds,exchanges}.ts`, `apps/api/src/checkout/data/exchange-addresses.json` (+ tests).

**Interfaces:**
- **Consumes:** project 2 `createDraft(ctx, { kind: 'refund', action })` and the refund `Action` shape (`{ asset, amount, destination_chain, destination, payment_id, route }`) from `apps/api/src/accounts/proposals.ts` / `encoding.ts`; the Task 7 outcomes.
- **Produces:**
  - **`queueReturn(ctx, payment, { reason, assetId, amount })`:**
    1. Compute the USD value; if < `SMALL_OVERPAY_USD`, mark `kept_small_overpayment` and stop.
    2. If the sender is in the exchange list, create the refund row with `needs_address: true`, emit `refund.needs_address`, and email `customer_email` (or flag that the checkout must ask).
    3. Otherwise create the refund row and a `refund` proposal **draft**, with the route derived as project 2 requires: Poa token for cross-chain, plain ft_withdraw for a NEAR destination. The amount is net of the estimated return fee. Then emit `refund.pending`.
  - **Signer approval** uses the existing approvals UI. The watcher from project 2 executes it, and this module listens for `account.proposal.executed` on refund proposals to mark the refund `confirmed` and emit `refund.sent`.
  - **`provideRefundAddress(clientSecret, { address, chain })`** (shopper route added to Task 5's router): fills a `needs_address` refund and creates the draft.
  - **Held (sanctions) refunds** require `acknowledged_legal_at`, set by a dashboard action (Task 10) before the draft can be created.

- [ ] **Step 1: Write failing tests:**
  - < $1 is kept (no draft);
  - an exchange sender becomes `needs_address` and the email is queued;
  - a normal manual-send overpay creates a refund draft with the right route and net amount;
  - a connected-wallet overpay creates no draft (1Click already refunded);
  - an executed proposal marks the refund sent;
  - a held payment draft without acknowledgement is refused.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): return-to-sender refunds via signer-approved proposals`.

---

### Task 9: Webhooks

**Files:** Create `apps/api/src/checkout/webhooks.ts`, `apps/api/src/routes/webhooks.ts` (+ tests). Modify `register-handlers.ts`.

**Interfaces — Produces:**
- **`signPayload(secret, t, rawBody): string`**, producing the header value `t=<t>,v1=<hex>`.
- **Endpoints routes** (`dashboard_user`, permission `settings:manage`, step-up for create and rotate):
  - `POST /v1/webhooks/endpoints {url, events?}` returns the secret once;
  - `GET` list;
  - `DELETE /:id`;
  - `POST /:id/rotate`;
  - `POST /:id/test` (sends a `ping` event);
  - `GET /:id/deliveries`;
  - `POST /v1/webhooks/deliveries/:id/resend`.
- **Delivery:**
  - the outbox handler fans each checkout event out to the matching endpoints;
  - POST with a 10 s timeout; 2xx = delivered;
  - retry backoff 1 min × 2^n until 3 days from the first attempt, then `failed`;
  - one `webhook_deliveries` row per (endpoint, event); idempotency key `whd_<endpoint>_<event>`.
- URLs must be `https://` in live (`http://localhost` allowed in test mode).

- [ ] **Step 1: Write failing tests:**
  - the signature verifies with a reference implementation;
  - a 5xx retries with growing delays;
  - give-up after 3 days of simulated time;
  - a resend after give-up delivers with the same event id (Review Focus 5);
  - the secret is shown only on create and rotate;
  - an `http://` URL is rejected in live;
  - a test-mode event is never sent to live endpoints.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS.
- [ ] **Step 3: Commit** `feat(api): signed checkout webhooks with retries and resend`.

---

### Task 10: Dashboard API + screens (payments, review queue, settings)

**Files:**
- Create `apps/api/src/routes/{payments,merchant-settings}.ts` (+ tests);
- Create `apps/web/src/app/dashboard/{payments,payments/[id],review,webhooks,settings/checkout}/page.tsx`;
- Modify `DashboardShell` nav.

**Interfaces — Produces:**
- **API (`dashboard_user`):**
  - `GET /v1/payments` (filters: status, date) and `GET /v1/payments/:id`, both `account:read`;
  - `GET /v1/review` — held payments, return-to-sender items and `needs_address` refunds;
  - `POST /v1/review/:paymentId/acknowledge-legal` (owner, step-up, body must include the typed phrase `I have legal clearance to refund this payment`);
  - `POST /v1/review/:paymentId/refund` (creates the draft through Task 8);
  - `GET/PATCH /v1/settings/checkout` (`settings:manage`) — `checkout_domains` (origins, `https://` only in prod, max 20), `default_fee_payer`, `default_gas_payer`.
- **Web screens:**
  - the payments list and detail (order amount, received, fees broken out, source token and chain, tx links, refunds);
  - the review queue (no "release" action exists for held funds);
  - webhook endpoints with a delivery log and resend;
  - checkout settings.

- [ ] **Step 1: Write failing tests:**
  - API: permissions, tenant/mode isolation, the typed phrase is required, domain validation.
  - Web vitest: formatting of fee lines.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS; run the web build.
- [ ] **Step 3: Commit** `feat: payments dashboard, review queue, webhooks and checkout settings`.

---

### Task 11: Checkout page

**Files:**
- Create `apps/web/src/app/pay/[sessionId]/{page.tsx, components/*}`, `apps/web/src/lib/checkout/{api.ts,status.ts,embed-bridge.ts}` (+ tests);
- Modify `apps/web/src/middleware.ts` (a `/pay/*` CSP branch) and `apps/web/next.config.ts`.

**Interfaces:**
- **Consumes:** Task 5 routes (the client secret is passed via the URL fragment `#cs=…` and kept in memory, never sent to the Next server).
- **Produces:**
  - **Screens** (spec §2):
    1. Choose token (search, popular first).
    2. Quote: exact amount, countdown to the quote deadline, auto-requote on expiry, fee lines only when the shopper pays, network warning.
    3. Pay: a connect-wallet button (Task 12 fills it in) or manual send with QR (`qrcode`), copy buttons and the "send only on <network>" warning.
    4. Status: detected → converting → settled.
    5. Terminal states: complete with tx link and a "Return to store" button to `success_url`; late; refunded; held ("We couldn't complete this payment"); `needs_address` form; email capture when needed.
  - **Status polling:** `GET /v1/checkout/client/session` every 2 s while visible.
  - **`embed-bridge.ts`:** when framed, posts `tendr:ready`, `tendr:status`, `tendr:complete` and `tendr:close` to `document.referrer`'s origin only if it is in the session's `checkout_domains`. Otherwise nothing is posted.
  - **`/pay/*` CSP:**
    - `frame-ancestors 'self' <merchant checkout_domains>`, looked up by the middleware via an unauthenticated `GET /v1/checkout/public/:sessionId/frame-origins` (add it to Task 5's router; returns only the origin list);
    - script nonce as in project 2;
    - `connect-src` allows the API plus the wallet providers' hosts listed in one config module.
  - Plain copy: no "intent", "solver" or "gas".

- [ ] **Step 1: Write failing vitest tests:**
  - `embed-bridge` posts only to allowed origins;
  - the status mapper turns API states into screen states;
  - the CSP builder includes the merchant domains in `frame-ancestors` and excludes them otherwise;
  - the client secret is read from the fragment and never appears in fetch URLs.
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS; run the web build.
- [ ] **Step 3: Commit** `feat(web): checkout page with quotes, manual send and live status`.

---

### Task 12: Wallet connections

**Files:** Create `apps/web/src/lib/wallets/{index,evm,solana,bitcoin,tron,near}.ts` (+ tests). Modify the pay screen and `apps/web/package.json`.

**Interfaces — Produces:**
- **`WalletAdapter`:** `{ chainFamily: 'evm'|'solana'|'bitcoin'|'tron'|'near'; connect(): Promise<{ address: string; chainId?: string }>; sendDeposit(q: { depositAddress: string; assetId: string; amount: string; decimals: number }): Promise<{ txHash: string }>; disconnect(): Promise<void> }`.
- **`adapterFor(assetId)`:** maps a 1Click asset to a chain family. Native vs token transfers per family:
  - EVM: native `sendTransaction`, ERC-20 `transfer`;
  - Solana: SOL and SPL transfer;
  - Bitcoin: PSBT/sendBitcoin through AppKit's bitcoin adapter;
  - Tron: TRX and TRC-20 via TronWeb from TronLink;
  - NEAR: `ft_transfer` / native transfer through Wallet Selector, with `storage_deposit` if required.
- **Flow:**
  1. On connect, call the quote with `refund_address` = the connected address (screening happens there).
  2. After `sendDeposit`, call `POST /v1/checkout/client/deposit` with the tx hash.
- **Iframe fallback:** if a wallet popup or deep link fails inside an iframe, open `/pay/[id]?wallet=1#cs=…` in a popup window. That window completes the wallet step and posts back to the opener.
- AppKit project id comes from env `NEXT_PUBLIC_REOWN_PROJECT_ID` (add to turbo.json).

- [ ] **Step 1: Write failing tests:**
  - `adapterFor` covers representative asset ids per family;
  - amount conversion to base units is exact (BigInt);
  - token vs native selection;
  - the NEAR transfer includes `storage_deposit` when unregistered (mocked view).
- [ ] **Step 2: Run** them and expect FAIL. **Implement.** **Run** them and expect PASS; run the web build.
- [ ] **Step 3: Commit** `feat(web): multi-chain wallet connections for checkout`.

---

### Task 13: Embed script + end-to-end tests

**Files:**
- Create `apps/web/src/embed/tendr.ts` and `apps/web/scripts/build-embed.mjs` (esbuild → `apps/web/public/v1/tendr.js`, minified);
- Create `apps/web/e2e/checkout.spec.ts` and `apps/web/e2e/fixtures/merchant-site.html`;
- Modify `playwright.config.ts` (serve the fixture site on a second origin, e.g. port 3200).

**Interfaces — Produces:**
- **`window.Tendr`:**
  - `.mount(el, { sessionUrl, onEvent })` creates the widget: an inline iframe with auto-height via `tendr:resize`.
  - `.open({ sessionUrl, onEvent })` creates the modal: an overlay iframe, closed on `tendr:close`/Esc.
  - It accepts messages only from `CHECKOUT_BASE_URL`'s origin.
  - No dependencies, < 10 KB.

- [ ] **Step 1: Write the e2e tests** (test mode, simulated provider, fake near client):
  - **Hosted:** create a session through the API, open the page, pick a token, quote, simulate `exact`, see settled, return to store; the store fixture receives the signed webhook and verifies it.
  - **Modal:** on the registered fixture origin it opens and receives `tendr:complete`.
  - **Widget:** on an unregistered origin, framing is refused (assert the CSP block / no `tendr:ready`).
  - **Edge cases:** underpay, then retry succeeds; late; overpay < $1 kept; sanctioned connected wallet refused; held manual send shows the held screen and a review-queue item.
- [ ] **Step 2: Run** `npm run test:e2e --workspace=@tendr/web` and expect PASS. Make sure the CI e2e job picks up the new spec.
- [ ] **Step 3: Commit** `feat(web): tendr.js embed and checkout end-to-end tests`.

---

### Task 14: Mainnet checkout verification script + docs

**Files:** Create `apps/api/scripts/verify-checkout-mainnet.ts` (+ arg/refusal tests). Modify `apps/api/package.json` (`checkout:verify:mainnet`) and `README.md` (checkout section).

**Interfaces — Produces:**
- **The script** follows project 2's safety pattern:
  - exact flag `--yes-i-understand-this-spends-mainnet-funds`;
  - user-supplied funded account;
  - plan printed with every cost;
  - spend capped at $5;
  - stops at the first FAIL;
  - a `--phase cleanup` path.
- **Checks (spec "Assumptions to verify early"):**
  1. `EXACT_OUTPUT` delivers the exact amount to an intents recipient, and an overpay excess goes to `refundTo`.
  2. A late deposit is refunded or swapped (print which).
  3. `appFees` arrives at the fee account.
  4. Chainalysis key works (`identifications` for a known sanctioned test address, empty for a clean one).
  5. INFO: 1Click status field shapes, and that the sender is present.

  Wallet-in-iframe behaviour (assumption 4) is a manual checklist in the README, not scripted.
- **README:**
  - creating sessions;
  - embedding (`tendr.js`);
  - registering domains;
  - webhook verification snippet (Node);
  - test-mode `simulate` scenarios;
  - who-pays settings;
  - the sanctions hold policy;
  - fee account setup (`fees.tendr.near` as a threshold-contract account provisioned with the project 2 tooling);
  - known limitations.

- [ ] **Step 1: Write the arg/refusal tests.** **Run** them and expect PASS (no network).
- [ ] **Step 2: Write the script and docs.** Run typecheck and lint.
- [ ] **Step 3: Commit** `chore: checkout mainnet verification script and docs`.

---

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| Goals: session API | 4 |
| Goals: three surfaces | 11, 13 |
| Goals: shopper flow, wallets | 11, 12 |
| Goals: settlement into merchant account | 7 |
| Goals: webhooks | 9 |
| Goals: edge cases | 7, 8, 13 |
| Goals: fees and who-pays | 3, 4, 10 |
| Goals: test mode | 2, 5, 13 |
| §1 Session API, who-pays resolution | 3, 4 |
| §2 Checkout page, framing, postMessage, wallets | 11, 12, 13 |
| §3 Quotes, 1Click call, expiry, test mode | 2, 3, 5 |
| §4 Watching, mapping, settlement verification, sender | 7 |
| §5 Fees, gas reimbursement, revenue | 3, 7 |
| §6 Edge-case table | 7, 8, 13 |
| §7 Screening (fail-closed, frozen holds) | 6, 7, 8, 10 |
| §8 Webhooks | 9 |
| §9 Dashboard | 10 |
| §10 Data model | 1 |
| User decisions after the builder check (one framed page, popup fallback; return fee deducted; < $1 kept; customer email) | 1, 5, 8, 11, 12 |
| Builder-check calls (underpay reopen, cancel = expired, merchant-pays-all, USD-only, frozen holds, fee account, shared domains) | 1, 3, 4, 8, 10, 14 |
| Acceptance (test-mode happy path, edge cases, modal/widget, who-pays, mainnet) | 13, 3, 14 |
| Assumptions to verify early | 14 |
