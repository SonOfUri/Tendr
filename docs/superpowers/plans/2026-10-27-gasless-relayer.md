# Gasless Payments, Relayer and Integrator Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shoppers pay with a token without holding the chain's coin (merchant sponsors, or the shopper pays the fee in their token or natively, their choice), and integrator contracts are notified of settled payments.

**Architecture:**
- API: a `gas/` module (policy, budget, fee pricing, sponsorship decision), a `relayer/` module with one submitter per chain family (EVM own sender + Pimlico proxy, Solana via Pimlico Kora, NEAR meta-transactions, Tron forwarder + just-in-time energy), each behind a common interface with a simulated test-mode implementation, and a `hooks/` module reusing the webhook retry pattern.
- On chain: one forwarder/batch contract (EVM + Tron, Solidity) and integrator reference receivers (EVM Solidity, NEAR Rust) under `onchain/`.
- Web: the pay page becomes wallet-first for wallet payments, shows the network-fee line or choice, and signs gasless payloads per family.

**Tech Stack:** existing Node 22 / TS ESM / Fastify 5 / Prisma 6 / Postgres 16 / Redis + BullMQ / Vitest / Next.js 15 / Playwright; ethers 6 (web and api); Reown AppKit; `@solana/kit` 6 + `@solana/kora` 0.2 + `@solana-program/token` 0.12 (api); `@near-js` (existing) for delegate actions; TronWeb (api, pinned); Foundry for Solidity (run in Docker, no host installs); Rust/near-sdk for the NEAR reference receiver (existing `onchain/` toolchain).

**Spec:** `docs/superpowers/specs/2026-10-27-gasless-relayer-design.md` (approved 2026-10-27). Section numbers (§N) refer to it. Read it with this plan.

## Global Constraints

- **Non-custodial:** every gasless payload the shopper signs binds the deposit address, payment amount, fee amount, fee recipient and a deadline. No open-ended approvals. A stolen relayer, Pimlico or gas-fee key can never send shopper funds elsewhere.
- **Paid means detected:** only the existing 1Click status + watcher marks a payment paid. A relayed submission never does.
- **Keys:** new named KMS keys `gas-fees-evm` (secp256k1), `gas-fees-tron` (secp256k1), `gas-fees-near` (ed25519), `gas-fees-solana` (ed25519). Collected fees never go to `relayer-evm`, `gas-tron` or `relayer-near`. Pimlico API key: `putSecret` purpose `pimlico`, server-side only, never in env, logs, Postgres plaintext or the browser.
- **Defaults:** new gas policy: $1 per payment, $50 per month, chains = all supported except `eth` (Ethereum mainnet opt-in). Tendr-wide daily unrecovered-loss cap $50 (`TENDR_SPONSOR_LOSS_CAP_USD`). Fee sweep threshold $20 equivalent or weekly. Calendar month in UTC.
- **Fee copy:** merchant sponsors → "Network fee: paid by {merchant name}"; shopper pays → choice "Pay the fee in {token}" ("+{amount} {symbol}") / "Pay the fee in {coin}"; no gasless method → "You'll need {coin} for the network fee".
- **Quote rule:** merchant-sponsored gas (and the integrator hook estimate) reduces the merchant's received amount; it never increases what the shopper sends, in both Tendr-fee modes. Shopper-paid token fee is added on top of the payment amount.
- **Fee pricing:** fee in a token = USD fee × (1 + `GAS_FEE_MARGIN_BPS`/10 000) ÷ the token's 1Click token-list price, rounded up to the token's base unit. Never a 1Click swap quote. `GAS_FEE_MARGIN_BPS` default 2000.
- **Tron is two signatures** (exact-amount `approve` + `TendrPayment`). **NEAR shoppers need ≥ 1 yoctoNEAR**; the relayer pays `storage_deposit` registrations.
- **Test mode:** every relayer path has a simulated implementation (no RPC, no Pimlico, no gas); flows, fee lines, budget reservations and records behave as live.
- **Nothing deployed:** no contract deployment, Terraform apply, live Pimlico use or push without the user. Contracts are built and tested locally only; deploy scripts exist but are not run.
- **Project norms:** Turbo strict env (every new env var in `turbo.json`), Prisma migrations, `PRISMA_ERRORS` mapping on routes, contracts in `packages/contracts`, tests per existing patterns, never touch a database named `tendr` (dev `tendr_foundation`, test `tendr_foundation_test`, port 5433; Redis 6380), no host installs (Docker for Foundry/TronBox), no Co-Authored-By / "Generated with" lines in commits.

## Review Focus

1. **Signature swapping:** a payload signed for session A (or quote A) submitted against session B, or with a different deposit address/amount → refused before any gas is spent (owner: Tasks 5, 7, 8, 9).
2. **Budget races:** two concurrent sponsored payments that together exceed the monthly budget or per-payment cap → exactly one is sponsored, the other falls back to shopper-pays (owner: Task 2).
3. **Quote expiry mid-sign:** the shopper signs after the quote deadline or Solana blockhash expiry → the relayer refuses, the shopper is re-quoted, no gas spent, no reservation leaked (owner: Tasks 3, 7).
4. **Already-used authorization (front-run):** the payment leg was executed by someone else first → the batch still completes the fee leg and the session is still detected as paid; no double charge (owner: Task 4, Task 5).
5. **Integrator contract reverting for 3 days** → `hook.failed`, merchant alerted once, resend works afterwards; the payment itself stays SETTLED (owner: Task 11).

## Task overview and order

1. Gas data model, policy API and keys
2. Budget reservation, sponsorship decision, loss cap
3. Fee pricing, quote changes, removal of the old discount, `network_fee` views
4. Forwarder/batch contract (EVM + Tron) — `onchain/evm`
5. Relayer core + EVM sender + EVM gasless submit
6. Pimlico EVM paymaster proxy (EIP-5792 / ERC-7677)
7. Solana via Pimlico (Kora)
8. NEAR meta-transactions
9. Tron forwarder flow and just-in-time energy
10. Pay page: wallet-first flow, fee choice, gasless signing
11. Integrator hooks (+ reference receivers)
12. Fee sweep, balance and loss alerts
13. Docs and dashboard handover note

---

### Task 1: Gas data model, policy API and keys

**Files:**
- Modify: `apps/api/prisma/schema.prisma`; Create migration `apps/api/prisma/migrations/20261027100000_gasless/migration.sql`
- Modify: `apps/api/src/keyvault/types.ts`, `apps/api/src/keyvault/keys.ts`
- Create: `packages/contracts/src/gas.ts` (+ export from `index.ts`), `apps/api/src/gas/policy.ts`, `apps/api/src/routes/gas.ts`; register in `apps/api/src/app.ts`
- Test: `packages/contracts/src/gas.test.ts`, `apps/api/src/gas/policy.test.ts`, `apps/api/src/routes/gas.test.ts`

**Interfaces:**
- Produces (contracts): `GasPolicySchema` (`enabled`, `per_payment_cap_usd`, `monthly_budget_usd`, `min_order_usd`, `chains: string[]`, `tokens: string[]`, `first_time_only`), `GasPolicyView`, `GasUsageView { month: "YYYY-MM", reserved_usd, spent_usd, remaining_usd, count }`, `FeeMode = 'token' | 'native'`, `NetworkFeeView { paid_by: 'merchant'|'shopper', fee_mode: FeeMode|null, amount: string|null, asset: string|null, usd: string, method: string|null }`, `DEFAULT_GAS_POLICY = { per_payment_cap_usd: '1', monthly_budget_usd: '50', min_order_usd: '0', chains: <all supported except 'eth'> }`.
- Produces (schema): `GasBudgetMonth { merchantId, livemode, month (YYYY-MM), reservedUsd, spentUsd, count }` unique `(merchantId, livemode, month)`; `GasSponsorship` gains `feeMode FeeMode?`, `feeAsset String?`, `feeAmount Decimal(78,0)?`, `estimateUsd Decimal(18,6)?`, `reservationState` (`reserved|settled|released`); `HookCall` gains `paymentId`, `nextRetryAt`, `leaseUntil`, `lastError`, `hookData Json`; `SponsorshipMethod` gains `forwarder`, `meta_tx`, `kora`. Named keys `gas-fees-evm|gas-fees-tron|gas-fees-near|gas-fees-solana`.
- Produces (API): `getGasPolicy(merchantId, livemode)`, `putGasPolicy(ctx, input)`, `gasUsage(merchantId, livemode, month)`; routes `GET/PUT /v1/gas-policy`, `GET /v1/gas-policy/usage?month=`, `GET /v1/gas-sponsorships` (filters `session`, `payment`, `status`, `month`; cursor pagination like other lists).

- [ ] **Step 1: Write failing tests:**
  - contracts: `GasPolicySchema` rejects negative caps, unknown chains, cap > budget; `DEFAULT_GAS_POLICY.chains` excludes `eth`.
  - `getGasPolicy` returns `DEFAULT_GAS_POLICY` with `enabled: false` when no row exists.
  - migration: a merchant with `default_gas_payer = merchant` gets an **enabled** policy with the defaults; one with `buyer` gets none.
  - routes: secret key can GET/PUT; a connection key can GET policy and usage but PUT → 403; publishable key → 403; cross-mode isolation (test key never sees live policy); usage for an empty month is all zeros.
  - keyvault: `curveOf('gas-fees-near') === 'ed25519'`, `curveOf('gas-fees-evm') === 'secp256k1'`.
- [ ] **Step 2: Run** `npx turbo run test --filter=@tendr/api --filter=@tendr/contracts` — expect FAIL.
- [ ] **Step 3: Implement** schema, migration (incl. the policy backfill), keys (comment each: "receive-only; used only by the fee sweep job"), contracts, policy module and routes.
- [ ] **Step 4: Run** the same command — expect PASS; `npx turbo run typecheck lint`.
- [ ] **Step 5: Commit** `feat(api): gas policy, usage and gas-fee keys`.

### Task 2: Budget reservation, sponsorship decision, loss cap

**Files:**
- Create: `apps/api/src/gas/budget.ts`, `apps/api/src/gas/sponsorship.ts`, `apps/api/src/gas/loss-cap.ts`
- Test: `apps/api/src/gas/budget.test.ts`, `apps/api/src/gas/sponsorship.test.ts`

**Interfaces:**
- Consumes: Task 1 schema and `getGasPolicy`.
- Produces:
  - `reserveBudget(tx, { merchantId, livemode, sessionId, usd: string, at: Date }): Promise<{ sponsorshipId: string } | null>` — locks the `GasBudgetMonth` row (`SELECT … FOR UPDATE`, creating it if absent), returns null if `reserved + spent + usd > monthly_budget`.
  - `settleReservation(tx, sponsorshipId, usd)`, `releaseReservation(tx, sponsorshipId)` — idempotent.
  - `decideSponsor(input: { merchantId, livemode, sessionId, chain, assetId, orderUsd, shopperAddress, feeUsd, sessionOverride, linkSetting, gasMaxUsd }): Promise<{ paidBy: 'merchant'|'shopper'; reason: 'policy_disabled'|'chain'|'token'|'min_order'|'not_first_time'|'per_payment_cap'|'budget'|'loss_cap'|'shopper_choice'|null }>` — pure checks in this order: resolved payer (session → link → merchant default), policy enabled, chain, token, min order, first-time (no earlier payment from `shopperAddress` to this merchant in this mode), `feeUsd ≤ min(per_payment_cap, gasMaxUsd)`, loss cap, budget (does not reserve).
  - `lossCapReached(livemode, now): Promise<boolean>` — sum of today's (UTC) `GasSponsorship.costUsd` with `sponsor = tendr` ≥ `TENDR_SPONSOR_LOSS_CAP_USD`.
  - Events: `gas.budget_low` once per month when spent+reserved crosses 80 %; `gas.budget_exhausted` once per month when a reservation is refused for budget.
- [ ] **Step 1: Failing tests:**
  - `two concurrent reservations of $30 against a $50 budget → exactly one succeeds` (real Postgres, two transactions in parallel).
  - `release then reserve again succeeds`; `settle adjusts reserved→spent by the given usd`; settle/release twice is a no-op.
  - `decideSponsor` returns each `reason` for its case, and `merchant` when all pass; `eth` refused under default policy; `first_time_only` refuses a returning shopper address.
  - `loss cap reached → shopper` and the operator alert event is emitted once per day.
  - `budget_low` emitted once at 80 %, not again the same month.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** — PASS (+ typecheck, lint). Add `TENDR_SPONSOR_LOSS_CAP_USD` (default 50) to env + `turbo.json`.
- [ ] **Step 5: Commit** `feat(api): gas budget reservations and sponsorship decision`.

### Task 3: Fee pricing, quote changes, `network_fee` views

**Files:**
- Create: `apps/api/src/gas/fees.ts`; Delete use of `apps/api/src/checkout/gas-estimates.ts` (keep only for copy-address fallback display, or remove if unused)
- Modify: `apps/api/src/checkout/pricing.ts` (`gasReimbursementMicroUsd` removed; new sponsored deduction), `apps/api/src/checkout/quotes.ts` (`QuoteInputSchema`, `createQuote`), `apps/api/src/checkout/payment-views.ts`, `apps/api/src/checkout/sessions.ts` (views), `apps/api/src/checkout/revenue.ts`, `packages/contracts/src/checkout.ts`
- Test: `apps/api/src/gas/fees.test.ts`, `apps/api/src/checkout/pricing.test.ts`, `apps/api/src/routes/checkout-client.test.ts`

**Interfaces:**
- Consumes: Task 2 `decideSponsor`, `reserveBudget`, `releaseReservation`.
- Produces:
  - `estimateNetworkFeeUsd(chain: string, method: GaslessMethod | 'native', opts: { livemode }): Promise<string>` — live per chain (EVM `eth_gasPrice` × method gas units from a table; Solana: fixed lamports + priority; NEAR: gas price × units; Tron: energy price × energy units), cached 30 s; simulated table in test mode.
  - `feeInToken(assetId: string, usd: string): Promise<{ amount: string /*base units*/, symbol, decimals }>` — Global Constraints formula; throws `FEE_TOKEN_UNPRICED` when the token list has no price (→ token option unavailable).
  - `GaslessMethod = 'eip3009'|'permit'|'paymaster'|'kora'|'meta_tx'|'forwarder'` (shared in contracts).
  - `QuoteInputSchema` gains optional `wallet_address`, `gasless_method: GaslessMethod`, `fee_mode: FeeMode`. When `wallet_address` + `gasless_method` are present, `createQuote` runs `decideSponsor` and, for merchant sponsorship, `reserveBudget`; stores on the quote `network_fee` (`NetworkFeeView`) plus the reservation id.
  - Merchant sponsored: estimated fee (+ hook estimate when `delivery = HOOK`, from Task 11's `HOOK_GAS_UNITS` — use a constant now, Task 11 refines) is subtracted from the merchant's received amount in **both** EXACT_INPUT and EXACT_OUTPUT modes; the shopper's `amount_in` is unchanged versus an unsponsored quote of the same order.
  - Shopper pays, `fee_mode = token`: the quote carries `fee_amount` (base units of the origin asset) to be sent **in addition** to `amount_in`; `fee_mode = native` or no gasless method: no fee fields, `network_fee.paid_by = 'shopper'`, `fee_mode = 'native'`.
  - A superseded or expired quote releases its reservation (re-quote and sweeper paths).
  - Session and payment views (secret key, connection key, shopper view) expose `network_fee`; `payment.succeeded` payloads include it; "You got paid" email shows "Network fee: paid by you ($0.04)" / "paid by the shopper".
- [ ] **Step 1: Failing tests:**
  - `feeInToken`: $0.08 at price 1.00 for USDC (6 dp) with 2000 bps → `"96000"`; unpriced token → `FEE_TOKEN_UNPRICED`.
  - pricing: sponsored quote has the same `amount_in` as an unsponsored one for the same order, in both fee-payer modes, and the merchant output is lower by the fee estimate; the old discount no longer exists.
  - quotes: without `wallet_address`, the quote has no reservation and `network_fee.paid_by = 'shopper'` with `fee_mode: 'native'` (copy-address path).
  - quotes: budget refused → `paid_by: 'shopper'`, reason surfaced to the pay page as `network_fee.reason`.
  - re-quote releases the previous reservation; expired-quote sweep releases it.
  - views: `network_fee` present on shopper view, merchant session view and `payment.succeeded`.
- [ ] **Step 2–4:** FAIL → implement (add `GAS_FEE_MARGIN_BPS` env + turbo) → PASS + typecheck + lint.
- [ ] **Step 5: Commit** `feat(api): live network fee, sponsored deduction and network_fee views`.

### Task 4: Forwarder/batch contract (EVM and Tron)

**Files:**
- Create: `onchain/evm/` Foundry project (`foundry.toml`, `src/TendrForwarder.sol`, `test/TendrForwarder.t.sol`, `script/Deploy.s.sol`, `README.md`), Docker runner `onchain/scripts/forge.sh` (runs the pinned `ghcr.io/foundry-rs/foundry` image).
- Create: `packages/contracts/src/forwarder.ts` (ABI, EIP-712 domain/type definitions, `TENDR_PAYMENT_TYPE`), generated from the build output.

**Interfaces:**
- Produces (Solidity): `TendrForwarder` — no owner, no admin, no storage except used nonces, no ETH/TRX receive.
  - `payWithAuthorizations(Auth3009 payment, Auth3009 fee)` — calls `receiveWithAuthorization`/`transferWithAuthorization` on the token for each leg; a leg whose nonce is already used (`authorizationState == true`) is **skipped**, not reverted; `fee` may be empty (zero value).
  - `payWithPermit(Permit permit, TendrPayment p, bytes sig)` — `try token.permit(...) {} catch {}` then requires `allowance(owner, this) ≥ p.amount + p.fee`; verifies the EIP-712 `TendrPayment{token, from, to, amount, fee, feeTo, deadline, nonce}` signature by `from`; marks `nonce` used; does exactly `transferFrom(from, to, amount)` and, if `fee > 0`, `transferFrom(from, feeTo, fee)`.
  - `payWithApproval(TendrPayment p, bytes sig)` — same as above without permit (Tron and approve-based tokens).
  - Events `TendrPaid(from, token, to, amount, fee, nonce)`.
  - EIP-712 domain: name `"TendrForwarder"`, version `"1"`, chainId, verifyingContract.
- Produces (TS): `TENDR_PAYMENT_TYPES`, `forwarderDomain(chainId, address)`, ABI fragments for api and web.

- [ ] **Step 1: Failing Foundry tests:**
  - signature by `from` for session A replayed with a different `to`/`amount`/`fee`/`feeTo` → revert.
  - expired `deadline` → revert; reused `nonce` → revert.
  - permit front-run (permit already executed by a third party) → payment still succeeds.
  - 3009 payment leg front-run (already used) → fee leg still executed, no revert.
  - after `payWithPermit`, allowance left to the forwarder is 0 when permit value = amount + fee.
  - contract holds zero token balance after every call; no function can move tokens other than those signed.
  - USDT-style token (no return value) works via SafeERC20.
- [ ] **Step 2: Run** `bash onchain/scripts/forge.sh test` — FAIL. **Step 3: Implement.** **Step 4:** PASS; `forge fmt --check`; gas snapshot committed.
- [ ] **Step 5:** `script/Deploy.s.sol` uses CREATE2 with a fixed salt (same address on every EVM chain); document the Tron compile (TVM-compatible solc, TIP-712 domain) in `README.md`; **do not run any deploy**. Commit `feat(onchain): TendrForwarder for gasless EVM and Tron payments`.

### Task 5: Relayer core, EVM sender and EVM gasless submit

**Files:**
- Create: `apps/api/src/relayer/types.ts`, `apps/api/src/relayer/index.ts`, `apps/api/src/relayer/simulated.ts`, `apps/api/src/relayer/evm/rpc.ts`, `apps/api/src/relayer/evm/sender.ts`, `apps/api/src/relayer/evm/payment.ts`
- Modify: `apps/api/src/routes/checkout-client.ts` (gasless routes), `apps/api/src/env.ts`, `turbo.json`
- Test: `apps/api/src/relayer/evm/*.test.ts`, `apps/api/src/routes/checkout-gasless.test.ts`

**Interfaces:**
- Consumes: Task 3 quote fields, Task 4 ABI/types, Task 2 settle/release.
- Produces:
  - `interface GaslessRelayer { options(q: QuoteContext): Promise<GaslessOption[]>; prepare(q, input): Promise<PreparePayload>; submit(q, signed): Promise<{ submissionId: string; txHash?: string }>; status(submissionId): Promise<'pending'|'submitted'|'confirmed'|'failed'> }` keyed by chain family; `relayerFor(family, livemode)` returns the simulated one in test mode.
  - Shopper routes (publishable, session-scoped, like existing `/v1/checkout/client/…`): `POST …/:session/gasless/options` (wallet address, asset) → available methods with fee lines; `POST …/:session/gasless/prepare` (quote id, method, fee_mode) → typed data / tx to sign; `POST …/:session/gasless/submit` (quote id, signatures) → submission id. Submit validates, **before spending gas**: session open, quote current and not expired, signed `to` = quote deposit address, amounts = quote `amount_in` (+ `fee_amount`), `feeTo` = Tendr's `gas-fees-evm` address, deadline ≤ quote deadline, signer = `wallet_address` on the quote. Per-session and per-address rate limits (5 submits / session, 20 / address / hour).
  - `EvmSender.send({ chainId, to, data }): Promise<{ txHash }>` using `relayer-evm` via KMS: per-chain nonce lock (Redis), EIP-1559 fees, replacement after 60 s unmined (+15 % tip), unknown-outcome reconciliation by nonce. RPC URLs from `EVM_RPC_URLS` (JSON chain → URL).
  - On submit success: `GasSponsorship` row (`provider = 'tendr'`, method), reservation kept; on chain failure: reservation released, session stays open; on confirmation: settle with the quoted estimate (§8.1).
- [ ] **Step 1: Failing tests:** signature for another session's quote → 409 `GASLESS_PAYLOAD_MISMATCH`, no RPC call made; expired quote → 409 `QUOTE_EXPIRED`; rate limit → 429; happy path (anvil in Docker, or a mocked JSON-RPC with recorded responses) submits one tx and records the sponsorship; stuck tx replaced with higher tip and same nonce; KMS signature recovers to the `relayer-evm` address; test mode never calls RPC.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck + lint.
- [ ] **Step 5: Commit** `feat(api): relayer core and EVM gasless submission`.

### Task 6: Pimlico EVM paymaster proxy

**Files:**
- Create: `apps/api/src/relayer/evm/pimlico.ts`; Modify: `apps/api/src/routes/checkout-client.ts`
- Test: `apps/api/src/relayer/evm/pimlico.test.ts`

**Interfaces:**
- Produces: `POST /v1/checkout/client/:session/paymaster` — an ERC-7677 endpoint (`pm_getPaymasterStubData`, `pm_getPaymasterData`) the browser passes as the `paymasterService` capability to `wallet_sendCalls`. It forwards to Pimlico's verifying paymaster (API key via `getSecret('pimlico')`) **only** if the user operation's calls are exactly: `token.transfer(depositAddress, amount_in)` and, for `fee_mode = token`, `token.transfer(gas-fees-evm address, fee_amount)`, matching the current quote and session; otherwise JSON-RPC error. Sponsorship policy id (Pimlico) from env `PIMLICO_SPONSORSHIP_POLICY_ID`.
- [ ] **Step 1: Failing tests:** calls with a different recipient/amount → refused, Pimlico never called; extra call appended → refused; valid calls → forwarded (Pimlico HTTP mocked); API key never appears in responses or logs; test mode returns simulated paymaster data.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(api): Pimlico paymaster proxy bound to the quote`.

### Task 7: Solana via Pimlico (Kora)

**Files:**
- Create: `apps/api/src/relayer/solana.ts`; Modify: relayer index, env
- Test: `apps/api/src/relayer/solana.test.ts`

**Interfaces:**
- Produces (implements `GaslessRelayer` for `solana`): `prepare` builds a v0 transaction with fee payer = `kora.getPayerSigner()`, a fresh `kora.getBlockhash()`, the SPL `transferChecked` of `amount_in` to the deposit address's ATA (creating it with the paymaster as rent payer when missing), and for `fee_mode = token` a second `transferChecked` of `fee_amount` to the `gas-fees-solana` ATA; returns the base64 message for the wallet to sign. `submit` decodes the partially signed transaction, **re-checks every instruction** (only those two transfers + ATA create, exact amounts, exact destinations, signer = quote wallet) and calls `kora.signAndSendTransaction`. Endpoint `https://solana.pimlico.io/v1/{mainnet|devnet}/rpc?apikey=…` (key server-side). Blockhash older than 60 s at submit → 409 `GASLESS_EXPIRED` (pay page re-prepares).
- [ ] **Step 1: Failing tests:** extra instruction → refused; changed amount → refused; stale blockhash → 409; native SOL payments are not routed here; happy path calls Kora (mocked) once; API key not leaked.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(api): gasless Solana payments through Pimlico`.

### Task 8: NEAR meta-transactions

**Files:**
- Create: `apps/api/src/relayer/near-meta.ts`; Modify: `apps/api/src/near/tx.ts` (`NearSigningKey` gains `'relayer-near'`), `apps/api/src/near/client.ts` (guard)
- Test: `apps/api/src/relayer/near-meta.test.ts`

**Interfaces:**
- Produces: `prepare` first ensures the deposit address and `gas-fees-near` are registered on the token contract (`storage_deposit` sent by `relayer-near`, idempotent via `storage_balance_of`), and checks the shopper account exists with ≥ 1 yoctoNEAR (else option unavailable with reason `near_account_needs_balance`). It returns the delegate-action actions to sign: `ft_transfer(deposit, amount_in)` with 1 yocto, plus `ft_transfer(gas-fees-near, fee_amount)` for `fee_mode = token`. `submit` verifies the `SignedDelegateAction` (signer = quote wallet, receiver = token contract, exactly those actions, `max_block_height` ≤ quote deadline) and sends it wrapped in a transaction from `relayer-near`.
- [ ] **Step 1: Failing tests:** delegate action with a different receiver or extra action → refused; unregistered deposit address gets one `storage_deposit` before prepare returns, and not twice; account with 0 balance → option unavailable; happy path submits once (fake NEAR client).
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(api): gasless NEAR payments via meta-transactions`.

### Task 9: Tron forwarder flow and just-in-time energy

**Files:**
- Create: `apps/api/src/relayer/tron.ts`, `apps/api/src/relayer/tron-energy.ts`; Modify: env (`TRON_RPC_URL`, `TRON_FORWARDER_ADDRESS`), relayer index
- Test: `apps/api/src/relayer/tron.test.ts`

**Interfaces:**
- Produces: two-step prepare: (1) `approve(TRON_FORWARDER_ADDRESS, amount_in + fee_amount)` unsigned tx for the shopper — before returning it, `gas-tron` delegates **just enough** energy/bandwidth for one approve to the quote's wallet address, only if the session is open, rate limits pass, and no delegation for this session exists; (2) after the approve is seen on chain, the `TendrPayment` TIP-712 typed data; `submit` calls `payWithApproval` from `gas-tron`. Delegations are reclaimed (`undelegateResource`) after the payment confirms or after 10 minutes, by a job; a ledger row per delegation.
- [ ] **Step 1: Failing tests:** prepare for a closed session → no delegation; a second prepare for the same session → no second delegation; reclaim job undelegates after confirmation and after the 10-minute timeout; approve amount ≠ amount + fee → submit refused; happy path (TronWeb mocked) calls `payWithApproval` once.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(api): gasless Tron USDT via forwarder and just-in-time energy`.

### Task 10: Pay page: wallet-first flow, fee choice, gasless signing

**Files:**
- Create: `apps/web/src/lib/wallets/gasless/{index,evm,solana,near,tron}.ts`, `apps/web/src/app/pay/[sessionId]/components/NetworkFee.tsx`
- Modify: `apps/web/src/lib/wallets/pay.ts` (`runWalletPay`), `PayFlow.tsx`, `WalletPanel.tsx`, `SendDetails.tsx`, adapters as needed
- Test: `apps/web/src/lib/wallets/gasless/*.test.ts`, `components.test.tsx`, `apps/web/e2e/gasless.spec.ts` (test mode)

**Interfaces:**
- Consumes: Task 5 routes, Task 6 paymaster URL, Task 3 quote fields, Task 4 types.
- Produces: wallet path order: choose token & chain → connect → `gasless/options` → quote with `wallet_address`, method, `fee_mode` → show `NetworkFee` → sign → submit (or native send). `NetworkFee` renders the exact Global Constraints copy; the choice appears only when both options exist; default `token`, preselect `native` when the wallet's native balance ≥ 2× the native fee. EVM method order: 3009 → permit → EIP-5792 paymaster (only when `wallet_getCapabilities` reports `paymasterService`) → native. Never request EIP-7702 delegation. Before signing, the client re-checks the payload (destination, amounts) against the quote (`assertDepositMatches`). Copy-address path: no discount, shows "You pay the network fee from your wallet".
- [ ] **Step 1: Failing tests:** method selection per wallet capability; payload mismatch blocks signing; fee choice hidden when merchant sponsors; copy strings exact; e2e (test mode, simulated relayer): sponsored EVM USDC payment completes with "Network fee: paid by …"; shopper-pays token fee shows "+0.08 USDC"-style line and completes; native choice uses the normal send.
- [ ] **Step 2–5:** FAIL → implement → PASS (`npx turbo run test --filter=@tendr/web`, Playwright) → commit `feat(web): gasless wallet payments and network fee choice`.

### Task 11: Integrator hooks and reference receivers

**Files:**
- Create: `apps/api/src/hooks/{deliver,hooks}.ts`, `apps/api/src/routes/hooks.ts`, `onchain/evm/src/reference/TendrDepositReceiver.sol` (+ tests), `onchain/integrator-near/` (near-sdk crate + tests)
- Modify: `apps/api/src/checkout/sessions.ts` (`delivery = HOOK`, `hook_data` for integrator merchants), `packages/contracts/src/checkout.ts`, worker registration
- Test: `apps/api/src/hooks/*.test.ts`, `apps/api/src/routes/hooks.test.ts`

**Interfaces:**
- Step 0 (spike, recorded in the task report): check whether 1Click NEAR delivery can carry a message to the destination contract (`ft_transfer_call` / `mt_transfer_call` / `ft_withdraw` with `msg`). If yes, NEAR integrator sessions request it with `hook_data` as the message and skip the relayer hook on NEAR; if no, NEAR uses the relayer hook. Record the evidence.
- Produces:
  - Session create accepts `hook_data` (JSON, ≤ 1 KB serialized) only for `kind = integrator` merchants whose settlement destination is a contract on NEAR or a supported EVM chain; sets `delivery = HOOK`.
  - On `payment.succeeded` (SETTLED) for a HOOK session: a `HookCall` row; `deliverHook` job calls `onTendrDeposit(bytes32 paymentId, bytes32 sessionId, bytes hookData, address token, uint256 amount, bytes32 txHash)` (EVM via `relayer-evm` sender) or `on_tendr_deposit({payment_id, session_id, hook_data, token, amount, tx_hash})` (NEAR via `relayer-near`). Retry schedule and window identical to webhooks (`retryDelayMs`, 3 days, leases, one in flight per payment); revert reason stored in `lastError`.
  - `HOOK_GAS_UNITS` per chain (replaces Task 3's constant); hook gas deducted from that payment's proceeds, never from the budget.
  - Events `hook.succeeded`, `hook.failed` (+ one merchant alert email on failure). Routes `GET /v1/hook-calls` (filters), `POST /v1/payments/:id/hook/resend` (secret key; refused while one is in flight).
  - Reference receivers: accept only the configured relayer address; track `accounted[token]`; credit `min(amount, balance − accounted)`; EVM version additionally records `txHash` to refuse duplicates.
- [ ] **Step 1: Failing tests:** hook only for integrators; hook_data > 1 KB → 400; delivery after SETTLED only; revert → retry with backoff, then `failed` + `hook.failed` + one email after the window; resend works after failure and is refused while in flight; reference contracts: non-relayer caller reverts, forged amount above unaccounted balance credits only the real balance, duplicate `txHash` refused.
- [ ] **Step 2–5:** FAIL → implement → PASS (api suite, `forge.sh test`, `cargo test` in Docker) → commit `feat: integrator onTendrDeposit hooks and reference receivers`.

### Task 12: Fee sweep, balance and loss alerts

**Files:**
- Create: `apps/api/src/jobs/fee-sweep.ts`, `apps/api/src/jobs/gas-alerts.ts`; Modify: `apps/api/src/worker.ts`, env, `turbo.json`
- Test: `apps/api/src/jobs/fee-sweep.test.ts`, `apps/api/src/jobs/gas-alerts.test.ts`

**Interfaces:**
- Produces:
  - `planFeeSweeps(livemode, now): Promise<SweepPlan[]>` — per gas-fee account and token, when value ≥ `FEE_SWEEP_THRESHOLD_USD` (20) or the last sweep is ≥ 7 days old: a 1Click quote to USDC on NEAR into Tendr's fee account. Execution requires `FEE_SWEEP_ENABLED=true` (operator gate; default false); otherwise plans are logged and an operator notice is sent. Each sweep is recorded; the gas-fee key signs only a transfer to the quote's deposit address.
  - `checkGasBalances()` every 15 min: relayer keys per chain and Pimlico balance below `GAS_LOW_BALANCE_USD` (default 50) → operator alert, once per 6 h per account. Loss-cap alert from Task 2 reused.
- [ ] **Step 1: Failing tests:** below threshold and < 7 days → no plan; ≥ threshold → one plan per token; disabled gate → no transfer signed, notice sent; enabled → only a transfer to the quote's deposit address is signed; alerts throttle at 6 h.
- [ ] **Step 2–5:** FAIL → implement → PASS → commit `feat(api): gas-fee sweep and gas balance alerts`.

### Task 13: Docs and dashboard handover note

**Files:**
- Create: `apps/docs/gasless/overview.mdx`, `apps/docs/gasless/gas-policy.mdx`, `apps/docs/integrations/hooks.mdx`; update `apps/docs/api-reference/webhooks.mdx` (events, `network_fee`), `apps/docs/docs.json`; `docs/handover/2026-10-27-gasless-relayer.md`; README section "Gasless payments" with the live checklist (Pimlico account and policy, contract review and deployment, key funding, sweep gate).
- [ ] **Step 1:** Write the pages: how gasless works per chain (incl. Tron two signatures, NEAR trace of NEAR), who pays, defaults, the fee choice, the copy-address exception; gas policy and usage APIs; hooks setup, ABI/NEAR interface, reference contracts, the **misattribution** limit and the required sender/balance checks. Handover note: how the APIs, events, jobs and keys work, with **suggested** screens (gas settings, usage this month, sponsorship log, hook delivery log, resend) — no screen-to-API mapping.
- [ ] **Step 2:** `npm run build --workspace=@tendr/docs` (or the Mintlify check the repo uses) passes; links resolve.
- [ ] **Step 3: Commit** `docs: gasless payments, gas policy, integrator hooks and handover note`.

---

## Spec coverage

| Spec § | Task(s) |
|---|---|
| Goals 1–2, §2.1–2.2 (who pays, fallback, budget, month, chain opt-in, loss cap) | 1, 2, 3, 10 |
| §2.3 methods: EVM 3009/permit/5792 + front-run | 4, 5, 6, 10 |
| §2.3 Tron two signatures + JIT energy | 4, 9 |
| §2.3 NEAR meta-tx, storage_deposit, yocto | 8 |
| §2.3 Solana via Pimlico | 7 |
| §2.4 copy-address, discount removed | 3, 10 |
| §2.5 pricing, shopper fee on top, recovery, gas-fee accounts, sweep | 1, 3, 12 |
| §2.6 records and `network_fee` | 1, 3 |
| §3 relayer keys, reliability, rate limits, test mode | 5–9 |
| §4 integrator hooks (+ atomic NEAR spike, misattribution) | 11, 13 |
| §5 APIs | 1, 3, 5, 6, 11 |
| §6 docs + handover | 13 |
| §8 builder-check answers, §9 user answers | throughout |
