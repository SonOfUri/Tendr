# Gasless Payments, Relayer and Integrator Hooks — Design (Project 5a)

Status: approved by the user 2026-10-27. Builds on checkout core (project 3), merchant accounts (project 2) and the WooCommerce plugin (project 4), all merged on local main.

Project 5 is split into three designs, done in this order (user's decision): **5a gasless payments + relayer + integrator hooks** (this document), **5b payment links**, **5c checkout branding** (themes, order summary, languages, branded emails, custom domain). The dashboard UI is **not** built by us in any of them: it is handed over to the person in charge of it. We document how our APIs and infrastructure work and only *suggest* screens (user's decision).

## Intent

A shopper who holds a token — USDC on Base, USDT on Tron, USDC on Solana — can pay with it **without holding the chain's own coin** (ETH, TRX, SOL, NEAR) for gas. Today the shopper's wallet signs and pays gas itself (`apps/web/src/lib/wallets/*`), so a shopper with USDC and no ETH is stuck. This is the most common reason a crypto checkout fails for ordinary people.

Separately, **integrator** merchants (a game, an on-chain app) receive payments into their own smart contract and need that contract told "this payment for this order arrived", so it can credit the right player or order without watching transfers.

## Goals

1. **Gasless token payments.** On every chain and token NEAR Intents supports where it is technically possible, a shopper paying from a connected wallet needs only the token they pay with. Paying with the chain's own coin already works (the fee comes out of that coin) and is unchanged.
2. **Who pays the network fee is the merchant's choice** (user's decision):
   - **Merchant sponsors:** the merchant covers the fee, within their gas policy (per-payment cap, monthly budget, and the policy's other limits). The cost is recovered from the merchant's side of the payment.
   - **Shopper pays:** the fee is taken out of the token the shopper sends. The shopper still needs nothing else in their wallet (user's decision).
   - When a sponsoring merchant's per-payment cap or monthly budget is exceeded, checkout falls back to **shopper pays from the token**, and the shopper sees the fee before confirming (my call — "quietly falls back rather than failing", accepted in the playback).
3. **Relayer** that submits these gasless transactions and pays gas up front, using Pimlico on EVM chains (foundation decision), Tendr's own `gas-tron` key on Tron (foundation decision), and `relayer-near` on NEAR. Solana: Pimlico (§9).
4. **Integrator hooks.** After an integrator's payment settles into its contract, Tendr's relayer calls `onTendrDeposit` on that contract (NEAR and EVM chains). Retries, failure status, alerting and a resend API.
5. **Handover documentation** for the dashboard owner: how the gas, sponsorship and hook APIs and infrastructure work, plus suggested screens (no screen-to-API mapping). Mintlify pages in `apps/docs` for integrators.

## Non-goals

- Gasless payments when the shopper **copies the deposit address** and sends from another app (we cannot sign for them). That path is unchanged: the shopper pays their own gas. Merchant sponsorship does not apply to it (my call — see §2.4).
- Bitcoin, Zcash, Doge and other chains whose payable assets are the chain's own coin: nothing to sponsor.
- Hooks on Solana and Tron (later).
- Dashboard screens (handed over).
- Payment links and branding (5b, 5c).
- AI routing recommendations (project 6, paid).

## Anti-goals (failure even if it technically works)

- **Tendr can move or redirect a shopper's money.** Every gasless method must bind the destination (the 1Click deposit address) and the exact amounts into what the shopper signs. No unlimited approvals to any Tendr address or contract. A compromised relayer, Pimlico account or gas key can at worst fail to submit, never send funds elsewhere.
- Tendr holds shopper funds in between. Money goes from the shopper's wallet straight to the deposit address (and the shopper-paid fee straight to Tendr's gas-fee account) in one transaction.
- A shopper is charged a fee they did not see before signing.
- A merchant's gas spending exceeds their policy (per-payment cap, monthly budget) because of a race between concurrent payments.
- A forged `onTendrDeposit` makes an integrator credit money that never arrived (see §4.4).
- The payment is marked paid because the gasless transaction was *submitted*, rather than because 1Click/our watcher saw the deposit, as today.

## 1. What exists today (recon, 2026-10-27)

- The pay page lets the shopper connect a wallet (Reown AppKit with ethers; Solana web3.js; TronLink; NEAR wallet selector) and send to the 1Click deposit address, or copy the address. Wallet sending lives in `apps/web/src/lib/wallets/` (`pay.ts runWalletPay`, `evm.ts`, `solana.ts`, `tron.ts`, `near.ts`, `bitcoin.ts`). EVM chains: eth, base, arb, op, pol, bsc, avax, gnosis, bera.
- Schema already has, unused: `GasPolicy` (enabled, perPaymentCapUsd, monthlyBudgetUsd, minOrderUsd, chains, tokens, firstTimeOnly), `GasSponsorship` (method, provider, userOpHash, sponsor, gasUsed, costUsd, recoveredFromPaymentId, status), `HookCall`, `SponsorshipMethod {eip3009, permit, paymaster, paymaster_verifying, paymaster_erc20, energy, fee_payer}`, `Sponsor {merchant, tendr}`, `Delivery {WEBHOOK, HOOK}`, `Session.hookData`, `RevenueSource.gas_reimbursement`, named keys `relayer-evm`, `relayer-near`, `gas-tron`.
- **Today's "gas payer = merchant" is a price discount, not sponsorship:** `pricing.ts` subtracts a capped *estimate* from what the shopper sends, using a static estimate table (`checkout/gas-estimates.ts`). The shopper still pays real gas. This design replaces that behaviour.
- NEAR transaction signing and sending exists for `relayer-accounts` (`near/client.ts call`, `near/tx.ts`); there is no EVM transaction builder or sender yet. BullMQ jobs and the DB-driven webhook retry pattern (`checkout/webhooks.ts`, 60 s × 2^(n-1), 3-day window, leases) exist and are reused.

## 2. Gasless payments

### 2.1 Shopper experience

- After choosing token and chain and connecting a wallet, the shopper sees one line: **"Network fee: paid by {merchant}"** or **"Network fee: 0.08 USDC (included)"**, then signs. For most tokens that is a single signature request with no ETH needed; the wallet shows what is being authorised.
- **When the shopper pays the fee, they choose how** (user's decision): **"Pay the fee in {token}"** (gasless, the fee in the token they are paying with, shown as e.g. "+0.08 USDC") or **"Pay the fee in {coin}"** (their wallet sends normally and pays gas in ETH, SOL, TRX or NEAR itself, exactly as today; Tendr collects nothing). The choice appears only when both are possible. Default (my call): the token option, because it always works; the pay page may preselect the native-coin option when the connected wallet already holds enough of it. When the merchant sponsors, there is no choice to make.
- If no gasless method exists for this wallet + chain + token (§2.3), the shopper sees **"You'll need {coin} for the network fee"** before signing, and the normal send flow runs, as today. Checkout never pretends to be gasless and then fails.
- The deposit is detected and confirmed exactly as today (1Click status + watcher). Submitting the relayed transaction never marks anything paid.

### 2.2 Who pays — resolution

- The resolved sponsor follows the existing order: session override → payment link → merchant default (`default_gas_payer`, values `merchant | shopper`; `Session.gasSponsor`, `gasMaxUsd`).
- **Merchant** applies only if the merchant's `GasPolicy` for the session's mode is enabled and the payment passes it: chain and token allowed, order ≥ `minOrderUsd`, `firstTimeOnly` rule (my reading: first payment from that shopper address to this merchant), quoted fee ≤ `perPaymentCapUsd` (and ≤ `gasMaxUsd` if set), and the reservation fits the remaining `monthlyBudgetUsd`. Otherwise → **shopper pays from the token**.
- **Budget is reserved atomically** when the shopper commits to sign (a row-locked or conditional update on the month's usage), released if the transaction is never submitted or fails, and settled to the actual cost when confirmed. Concurrent payments can never exceed the budget (anti-goal).
- "Month" is the calendar month in UTC (my call).
- **Expensive chains are opt-in.** A new gas policy allows sponsorship on cheap chains only (Base, Arbitrum, Optimism, Polygon, BSC, Gnosis, Avalanche, Berachain, Solana, NEAR, Tron); **Ethereum mainnet is off by default** and the merchant must add it. Tendr-wide, unrecovered sponsorship losses (`sponsor = tendr`, §2.5) have a daily cap (default $50, operator-configurable); when reached, new sessions stop being sponsored (they fall back to "shopper pays") and operators are alerted.

### 2.3 Methods by chain (the builder picks within these rules)

The fixed rules: the shopper signs; the signature binds the deposit address, the payment amount, the fee amount and recipient, and a deadline; nothing grants an open-ended allowance; one on-chain transaction moves the payment and the fee together (except Tron, which needs a prior exact-amount approval, see below). Method preference per chain, falling back down the list, then to "shopper needs the chain's coin":

- **EVM** (eth, base, arb, op, pol, bsc, avax, gnosis, bera):
  1. **EIP-3009 `transferWithAuthorization`** (USDC and other tokens that support it): the shopper signs typed data; `relayer-evm` submits. For "shopper pays", a second authorization moves the fee to Tendr's gas-fee address in the same relayed transaction (via a small Tendr batch contract, see below).
  2. **EIP-2612 `permit`** tokens: the shopper signs a permit to Tendr's **payment forwarder** contract *plus* an EIP-712 `TendrPayment{token, to=depositAddress, amount, fee, feeTo, deadline, nonce}`; the forwarder checks both signatures and does exactly two `transferFrom`s. The permit value equals amount + fee, so nothing is left approved.
  3. **Wallets that support sponsored calls (EIP-5792 `wallet_sendCalls` with a paymaster capability, e.g. smart wallets) or EIP-7702**: use Pimlico (verifying paymaster when the merchant sponsors; for "shopper pays" too, with the fee transfer in the payment token to Tendr's gas-fee address batched into the same calls, so it works for any supported token, not only those Pimlico's ERC-20 paymaster accepts).
  4. Otherwise (e.g. USDT on Ethereum in a plain wallet): shopper needs ETH.
  - **Front-running tolerance.** Signed EIP-3009 authorizations and permits are public once submitted, so anyone can execute one first and make the batch revert. The batch/forwarder contract must tolerate an already-used authorization: wrap `permit` in try/catch and proceed if the allowance is already sufficient; skip an EIP-3009 authorization whose nonce is already used (the transfer already happened to the bound destination). The payment and fee legs are checked independently so a front-run payment leg does not strand an unused fee leg. The builder tests these cases explicitly.
  - The forwarder/batch contract is tiny, immutable, has no owner and no admin functions, holds no balance between transactions, and is deployed at the same address on each EVM chain. It gets its own tests and an external review before mainnet.
- **Tron — two signatures, by design.** USDT-TRC20 has no `permit` and no signed-transfer method, so a one-signature, destination-bound path does not exist; the builder should not look for one. Flow: (1) the shopper signs an **`approve` for exactly amount + fee** to Tendr's **Tron forwarder** contract; (2) the shopper signs a `TendrPayment{token, to=depositAddress, amount, fee, feeTo, deadline, nonce}` message that the forwarder verifies before doing exactly two `transferFrom`s. `gas-tron` pays for the forwarder call. For the `approve` transaction itself, `gas-tron` **delegates energy/bandwidth just in time**, only to the connected address of an **open** session that has passed rate limits, only enough for that one approve, and **reclaims** it afterwards; delegation is never granted speculatively, so spam sessions cannot drain it. The forwarder follows the same rules, review and go-live gate as the EVM one (user's decision, §9).
- **NEAR:** NEP-366 meta-transactions (signed delegate actions) relayed by `relayer-near`, which pays gas. "Shopper pays": the delegate action includes an `ft_transfer` of the fee to Tendr's NEAR gas-fee account. Two NEAR facts limit "nothing but the token": `ft_transfer` requires a 1 yoctoNEAR attached deposit, which in a delegate action comes from the shopper's own account, and the receiving accounts must be registered on the token contract. So: **the relayer registers the deposit address (and Tendr's fee account) with `storage_deposit` itself, in a separate transaction it pays for, before the shopper signs**; and the shopper's NEAR account must exist and hold a trace of NEAR (1 yoctoNEAR — almost every account does). The pay page says so if the account cannot cover it.
- **Solana:** Pimlico's Solana paymaster (Kora JSON-RPC, `@solana/kora`; endpoint `solana.pimlico.io/v1/{mainnet|devnet}/rpc`, API key server-side only). The shopper signs a transaction whose fee payer is Pimlico's paymaster; the paymaster co-signs and broadcasts. **Merchant sponsors:** no payment instruction, so the fee is charged to Tendr's Pimlico balance and recovered per §8.1. **Shopper pays:** the transaction is sponsored the same way (charged to Tendr's Pimlico balance), and a second transfer of the fee **in the token the shopper is paying with** goes to Tendr's Solana gas-fee account in the same transaction (§2.5). This works for any token NEAR Intents supports on Solana, not only USDC/USDT. Before the shopper signs, the pay page checks the transaction contains only the deposit transfer and the quoted fee transfer, and shows the fee. Rebuild when the ~1-minute blockhash expires. Pimlico's limits apply (paymaster used only as fee and rent payer, at most 0.1 SOL per transaction).

### 2.4 The copy-address path and the old discount

- Copying the deposit address stays as today: the shopper pays their own gas. The old "gas payer = merchant" price discount is **removed** (my call: a discount for an estimated fee the shopper still pays themselves is not sponsorship, and two meanings of "merchant pays gas" would confuse merchants). If the merchant sponsors and the shopper copies the address, the shopper simply pays their own fee; the pay page says so next to the copy option.

### 2.5 Fees, costs and recovery

- **Quoting the fee:** the network fee is quoted live per chain at the time the shopper reviews (replacing the static estimate table), with a safety margin; it is the fee shown and, for "shopper pays", the exact token amount signed.
- **Shopper pays:** the fee is paid **in the token the shopper is paying with** — any token NEAR Intents supports, not only USDC/USDT (user's decision) — to Tendr's **gas-fee account** on that chain, in the same transaction, and is recorded as revenue (`gas_reimbursement`). The fee amount in that token is priced from the token's price in 1Click's token list (not a swap quote — fee-sized amounts are often below 1Click's minimum quote size), plus the safety margin. Tendr keeps any difference between the quoted fee and the actual cost; it never charges more than the shopper signed.
- **Converting collected fees:** a scheduled operator job swaps each gas-fee account's collected tokens to USDC (or USDT) through NEAR Intents / 1Click, like any other swap, once a balance passes a threshold (my call: $20 equivalent, or weekly). Tendr bears the price movement between collection and swap. (The sweep may also top up a relayer key with native coin, as an operator-approved step.)
- **Gas-fee accounts are separate from the hot relayer keys.** Collected fees never sit on `relayer-evm`, `gas-tron` or `relayer-near`, so a compromised relayer key can only waste its own working gas. New named KMS keys, receive-only in normal operation: `gas-fees-evm` (secp256k1, one address on all EVM chains), `gas-fees-tron` (secp256k1), `gas-fees-near` (Ed25519), `gas-fees-solana` (Ed25519). Only the scheduled sweep job uses them, and only to send to 1Click deposit addresses for the swap. The relayer keys hold just enough working gas, topped up out of band.
- **Merchant sponsors:** Tendr (via its Pimlico balance, `gas-tron`, `relayer-near`, or the Solana fee payer) pays the actual cost up front. The cost is recovered from that payment's merchant proceeds through the same fee mechanism checkout core uses for Tendr's fee, recorded in `GasSponsorship` (`sponsor = merchant`, `costUsd`, `recoveredFromPaymentId`) and as `gas_reimbursement` revenue. If recovery is impossible (e.g. the payment never settles), the cost is Tendr's loss, recorded with `sponsor = tendr` — it is never charged to the merchant later (my call).
- **Relayer funding:** Tendr keeps its Pimlico balance and the gas keys topped up out of band; low-balance alerts are part of this project. Pimlico's API key is a stored secret (`putSecret`, purpose `pimlico`), never in env or Postgres plaintext.

### 2.6 Records and events

- Every sponsored or relayed transaction writes a `GasSponsorship` row (chain, method, provider, tx hash / user-op hash, sponsor, gas used, cost, status). Session and payment views expose `network_fee: { paid_by: "merchant"|"shopper", amount, asset, method }`.
- `payment.succeeded` webhooks and "You got paid" emails show the network fee and who paid it.

## 3. Relayer

### 3.1 Keys and submission

- `relayer-evm` (secp256k1, KMS) submits EIP-3009 and forwarder transactions on each EVM chain and pays their gas; Pimlico handles the paymaster path. A new EVM transaction builder/sender is needed (nonce management per chain, fee estimation, replacement on stuck transactions, unknown-outcome handling), mirroring the NEAR sender's guarantees.
- `relayer-near` (Ed25519) submits meta-transactions and hook calls on NEAR; the existing NEAR sender is extended to it.
- `gas-tron` handles Tron (forwarder calls and just-in-time energy delegation, §2.3).
- `gas-fees-evm`, `gas-fees-tron`, `gas-fees-near`, `gas-fees-solana` receive shopper-paid fees and are used only by the sweep job (§2.5).
- None of these keys is a signer on any merchant account or able to move shopper funds; a stolen key can only waste its own gas balance or fail to submit.

### 3.2 Reliability

- A submitted transaction that is not mined within its deadline is retried or replaced; if the quote deadline passes, the shopper is asked to re-quote and sign again (existing re-quote flow in `runWalletPay`).
- Rate limiting per session and per shopper address so the relayer cannot be drained by spam signatures (signatures for sessions that are not open are refused before any gas is spent).

### 3.3 Test mode

- Test mode simulates the relayer (no real gas, no Pimlico calls), consistent with checkout core's simulated 1Click: the shopper flow, fee line, budget reservation and `GasSponsorship` records all behave as live.

## 4. Integrator hooks

### 4.1 Setup

- An integrator merchant (`merchants.kind = integrator`) settles into its own contract: the contract address is the store's payout destination, set and approved through the existing saved-address and `set_settlement` proposal flow (merchant accounts). Supported hook chains: NEAR and EVM chains listed above.
- Sessions for integrators use `delivery = HOOK` and carry `hook_data` (the integrator's own order or player reference, size-limited) given at session creation.

### 4.2 The call

- **NEAR: prefer an atomic notification.** If 1Click's NEAR delivery can carry a message (an `ft_transfer_call` / `mt_transfer_call`, or `ft_withdraw` with a `msg`) to the destination contract, the settlement transfer itself carries `hook_data` and calls the integrator's contract — atomic with the money and impossible to forge, so no relayer trust is needed. The builder verifies this first; if supported, NEAR integrators use it and the relayer hook is used on EVM chains only. Otherwise NEAR uses the relayer hook below.
- When the payment is **SETTLED** (confirmed delivered to the contract, as today), the relayer calls `onTendrDeposit(paymentId, sessionId, hookData, token, amount, txHash)` on the contract. Exact ABI / NEAR method signature: published in docs with a reference contract for each.
- **Hook gas is always deducted from that payment's own proceeds** (built into the quote, §8.1) and **does not count against the sponsorship budget**, so it never conflicts with the budget limit. The hook is always sent.
- Webhooks are still sent if the integrator has endpoints.

### 4.3 Retries and failure

- Same pattern as webhooks: exponential backoff from 60 s, 3-day window, leases, at most one in flight per payment. Each attempt updates `HookCall` (attempt, tx hash, status). After the window: status `failed`, event `hook.failed`, alert email to the merchant. `POST /v1/payments/:id/hook/resend` retries on demand.
- A revert is retried (the contract may be paused); the revert reason is stored.

### 4.4 Forged notifications

- The reference contract accepts `onTendrDeposit` only from Tendr's published relayer address for that chain, **and** credits at most the token balance it has received but not yet accounted for (it tracks `accounted[token]`). So even a compromised relayer key cannot make it credit money that never arrived. It **can** still misattribute: with two deposits pending, a forged hook could credit player A with player B's deposit. The docs say so plainly. Where the chain allows, the reference contract also checks each hook's amount against the specific settlement (the `txHash` / transfer it names); integrators who need stronger guarantees use the atomic NEAR path or reconcile against Tendr's signed webhooks. The docs require integrators to keep the sender and balance checks.

## 5. APIs (new or changed)

- `GET/PUT /v1/gas-policy` (per mode): enabled, per-payment cap, monthly budget, min order, chains, tokens, first-time-only; `GET /v1/gas-policy/usage` (month to date: reserved, spent, remaining, count).
- `GET /v1/gas-sponsorships` (list, filters: session, payment, status, month).
- Session/payment views: `network_fee` (§2.6); session create: `gas_payer` override and `hook_data` (integrators).
- Pay-page (publishable) endpoints for the shopper flow: get gasless options for wallet + chain + token; submit the signed authorization for relaying; status.
- `GET /v1/hook-calls`, `POST /v1/payments/:id/hook/resend`.
- Events: `gas.budget_low` (80 % used), `gas.budget_exhausted`, `hook.succeeded`, `hook.failed`.
- Connection keys (WooCommerce) may read the gas policy and usage, and set `default_gas_payer` as today; they may not change the policy (my call).

## 6. Handover documentation

- `apps/docs`: Gasless payments (how it works, who pays, limits), Gas policy API, Integrator hooks (setup, ABI/NEAR interface, reference contracts, security checks), plus updates to webhooks/events.
- A handover note for the dashboard owner: how gas policy, usage, sponsorship records, hook calls and their events work, with **suggested** screens (gas settings, usage this month, hook delivery log). No screen-to-API mapping (user's decision).

## 7. Constraints

- Non-custodial throughout (anti-goals). No new private keys in Postgres; KMS for signing keys, `putSecret` for API secrets.
- Live sponsorship and the forwarder contract go live only after the user says so; nothing deployed or applied (Terraform, contracts) without the user (standing rule).
- Same stack and conventions as projects 1–4; Turbo strict env; tests per project norms; never touch the `tendr` database.

## 8. Builder-check answers (my calls unless noted)

1. **Recovering merchant-sponsored gas.** The pay page asks for the wallet **before** the final quote when the shopper chooses "connect wallet" (choose token and chain → connect → quote → sign); the copy-address path quotes as today. Sponsorship is decided at quote time (method available, `firstTimeOnly` against the connected address, live fee estimate against the caps). The **estimated** network cost, including the integrator hook call when `delivery = HOOK`, is built into the quote as a reduction of the **merchant's** received amount — it never increases what the shopper sends, in either Tendr-fee mode. The merchant is charged that quoted estimate, not the later actual cost; Tendr keeps or absorbs the difference, and `GasSponsorship` records both. No carried-forward debts. If the fallback to "shopper pays" is needed after quoting, the shopper re-quotes (existing re-quote flow). This replaces "settled to the actual cost" in §2.2/§2.5: the budget reservation is released or adjusted to the quoted estimate. The hook-call estimate is part of the deduction but not of the budget (§4.2).
2. **"Shopper pays" fee is on top.** The shopper sends the payment amount (as quoted today) **plus** the network fee; the merchant receives the full payment. The UI line reads "Network fee: +0.08 USDC". (§2.1 wording updated by this.)
3. **EIP-7702.** Never ask a shopper to delegate their wallet. The Pimlico path is used only when the wallet already offers sponsored calls (EIP-5792 paymaster capability, smart wallets) or already has a delegation the wallet itself manages. Ordinary wallets use EIP-3009 / the permit forwarder.
4. **Existing "merchant pays gas" settings.** No merchant is live yet. The setting keeps its name and now means real sponsorship under the gas policy; merchants with it set get a policy created with the default limits (see §9, Q3). Sessions open at release keep their quoted amounts.

## 9. User's answers (2026-10-27)

1. **Solana: Pimlico** (the user supplied Pimlico's Solana guide, https://docs.pimlico.io/guides/how-to/solana). Pimlico always sponsors the SOL fee; when the shopper pays, Tendr collects the fee in the shopper's own token (§2.5), so no Tendr-run Solana fee payer is needed — only the receive-only `gas-fees-solana` key.
2. **Tron: add a small Tron forwarder contract.** USDT-TRC20 has no native one-signature, destination-bound method, so Tron uses an exact-amount approve plus the forwarder (two signatures, §2.3). Same rules, review and go-live gate as the EVM forwarder.
3. **Default sponsorship limits:** $1 per payment, $50 per month, editable by the merchant.
4. **Shopper-paid fees in any supported token** (user's decision): the fee is collected in the token the shopper pays with and swapped to USDC/USDT later through NEAR Intents (§2.5).
5. **The shopper chooses the fee currency** when they pay the fee: the token they are paying with (gasless) or the chain's native coin (normal wallet send, as today) (§2.1).
6. **Review fixes adopted (2026-10-27):** separate receive-only gas-fee accounts on every chain; Tron is two signatures with just-in-time, reclaimed energy; NEAR needs a trace of NEAR and relayer-paid `storage_deposit`; batch/forwarder tolerate front-run authorizations; atomic NEAR notification preferred if 1Click supports it; misattribution risk documented; Ethereum mainnet sponsorship opt-in and a Tendr-wide daily loss cap; fee priced from the token list; hook gas outside the budget.

## 10. Left to the builder

Exact per-chain method selection within §2.3's rules; EVM sender internals; the fee safety margin; the reference contracts' code; job and table details beyond the existing schema.
