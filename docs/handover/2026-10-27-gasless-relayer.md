# Handover: gasless payments, relayer and integrator hooks

For the person building the dashboard. This note describes how the APIs, events, jobs and keys that
make up gasless payments work. The screens at the end are suggestions only. Nothing here dictates how
the dashboard looks or which call feeds which screen.

Customer-facing docs are in `apps/docs` (`gasless/overview`, `gasless/gas-policy`,
`integrations/hooks`, `api-reference/webhooks`). Design: `docs/superpowers/specs/2026-10-27-gasless-relayer-design.md`.

## How it works, in short

- A shopper pays with a token and no gas coin. The pay page asks the wallet to sign a payload that binds
  the deposit address, the amounts, the fee recipient and a deadline. Tendr's relayer submits it and pays
  the gas. Submitting never marks a payment paid; the existing 1Click status and watcher do.
- Each merchant has a gas policy per mode (test and live). When the store's gas payer is `merchant` and
  a payment passes the policy, Tendr pays the fee and takes it from that payment's merchant proceeds.
  Otherwise the shopper pays the fee out of the token they send, or in the chain's coin.
- Integrator stores settle into their own contract. After settlement the relayer calls the contract's
  hook. Failures are retried, then alerted, and can be resent.

## Merchant APIs

All are under `/v1`, per mode. Auth is a secret key, or a dashboard session with the permission shown.

| Call | Key scope | Dashboard permission |
| --- | --- | --- |
| `GET /v1/gas-policy` | any secret key (connection keys too) | `account:read` |
| `PUT /v1/gas-policy` | `sessions:write`; connection keys get 403 | `settings:manage` plus step-up |
| `GET /v1/gas-policy/usage?month=YYYY-MM` | any secret key | `account:read` |
| `GET /v1/gas-sponsorships` | `payments:read` | `account:read` |
| `GET /v1/hook-calls` | `payments:read`; connection keys refused | `account:read` |
| `POST /v1/payments/{id}/hook/resend` | `sessions:write`; connection keys refused | `webhooks:resend` |

Request and response shapes, filters and error codes are in `apps/docs/gasless/gas-policy.mdx` and
`apps/docs/integrations/hooks.mdx`. Points that are easy to miss:

- **Policy.** Fields: `enabled`, `per_payment_cap_usd`, `monthly_budget_usd`, `min_order_usd`, `chains`,
  `tokens`, `first_time_only`. `PUT` merges the fields sent over the current policy and validates the
  result (the cap cannot exceed the budget). A mode with no row returns the defaults, disabled, with
  `updated_at: null`. Defaults: $1 per payment, $50 per month, every chain except `eth`. Chain ids are
  `eth base arb op pol bsc avax gnosis bera sol near tron`.
- **Switching the store's default gas payer to merchant** (`default_gas_payer` in
  `PATCH /v1/settings/checkout`) creates the default policy, enabled, if the mode has none. It never
  changes an existing policy.
- **Usage.** `reserved_usd` (held, not settled), `spent_usd` (settled), `remaining_usd`
  (budget minus both, floored at zero), `count`. The month is a calendar month in UTC. Budget is reserved
  atomically when the shopper commits to sign and released if the payment is never submitted or fails.
- **Sponsorship record.** `sponsor` is `merchant` or `tendr` (a loss Tendr absorbed, never charged to the
  merchant). `estimate_usd` is what the merchant was charged, `cost_usd` the actual cost.
  `reservation_state` is `reserved | settled | released | null`. `status` is
  `pending | submitted | confirmed | failed`.
- **Network fee on sessions and payments.** `network_fee`: `{ paid_by, fee_mode, amount, asset, usd,
  method, reason }`, null for payments quoted before this feature. `reason` is the full reason on
  merchant views (`shopper_choice`, `policy_disabled`, `chain`, `token`, `min_order`, `not_first_time`,
  `per_payment_cap`, `loss_cap`, `budget`, `fee_unavailable`, `fee_token_unpriced`). Shoppers see a
  reduced set.
- **Session create** accepts `gas_payer` (`merchant | shopper`) and, for integrator stores, `hook_data`.
- **Hook call.** `status` is `pending | submitted | succeeded | failed`. A resend is allowed only when the
  call is `failed` and not in flight; otherwise 409.

### Shopper-facing endpoints (not for the dashboard)

The pay page uses `/v1/checkout/client/gasless/options`, `.../prepare` and `.../submit`, plus a per-quote
paymaster URL for smart wallets. They are authenticated by the shopper's session client secret, rate
limited per session and per wallet, and check every signed field against the quote before any gas is
spent.

## Events

Merchant webhooks (signed, retried for 3 days; see `apps/docs/api-reference/webhooks.mdx`):

| Event | Meaning |
| --- | --- |
| `gas.budget_low` | Reserved plus spent crossed 80% of the month's budget. Once per month per mode. |
| `gas.budget_exhausted` | A payment was not sponsored because the budget is used up. Once per month per mode. |
| `hook.succeeded` | The contract accepted the hook call. |
| `hook.failed` | Tendr gave up. Once per hook call, with one alert email to the store's notification email. |
| `payment.succeeded` | Now carries `network_fee`. |

Internal events (no webhook, written to the event log as system events with no merchant, plus an
`OPS ALERT` log line): `gas.loss_cap_reached` (once per UTC day per mode), `gas.relayer_balance_low`,
`gas.pimlico_balance_low`, `gas.fee_sweep_waiting`, `gas.fee_sweep_needs_gas`, `gas.fee_sweep_failed`
(each at most once per 6 hours per account). Policy changes write `gas_policy.updated` with the actor and
the policy before and after. These are for operators; the merchant dashboard does not receive them.

## Jobs (worker)

| Job | Queue | Schedule | What it does |
| --- | --- | --- | --- |
| `release-gas-reservations` | checkout | every 60 s | Releases budget held by quotes that were replaced or expired unused (5 minute grace). |
| `poll-evm-relays` | checkout | every 15 s | Follows relayed EVM transactions, Pimlico user operations, Solana, NEAR and Tron relays and NEAR hooks to their final outcome and records cost. |
| `deliver-hook` | webhooks | per attempt, delayed for retries | One hook call attempt. |
| `sweep-hooks` | webhooks | every 60 s | Re-queues hook calls whose retry is due. |
| `fee-sweep` | maintenance | hourly, production only | Plans and, only with `FEE_SWEEP_ENABLED=true`, executes swaps of collected gas fees into USDC on NEAR. |
| `check-gas-balances` | maintenance | every 15 min, production only | Alerts when a relayer key's native balance or the Pimlico balance is below `GAS_LOW_BALANCE_USD`. |

`fee-sweep` and `check-gas-balances` are scheduled only when `NODE_ENV=production`, and run in live mode
only.

## Keys and secrets

KMS-backed named keys:

| Key | Type | Role |
| --- | --- | --- |
| `relayer-evm` | secp256k1 | Submits EVM gasless transactions and hook calls; pays their gas. |
| `relayer-near` | ed25519 | Submits NEAR meta-transactions, token registrations and hook calls. |
| `gas-tron` | secp256k1 | Calls the Tron forwarder; lends energy just in time. |
| `gas-fees-evm`, `gas-fees-tron`, `gas-fees-near`, `gas-fees-solana` | secp256k1, secp256k1, ed25519, ed25519 | Receive shopper-paid fees. Used only by the sweep, which signs one transfer to a 1Click deposit address. |

The Pimlico API key is a stored secret (`putSecret`, purpose `pimlico`). It never goes in env, logs or
the browser. None of these keys can move shopper funds elsewhere: payloads are bound to the deposit
address.

Environment variables: `GAS_FEE_MARGIN_BPS` (default 2000), `TENDR_SPONSOR_LOSS_CAP_USD` (default 50),
`FEE_SWEEP_ENABLED` (default false), `FEE_SWEEP_THRESHOLD_USD` (default 20), `TENDR_FEE_ACCOUNT_NEAR`,
`GAS_LOW_BALANCE_USD` (default 50), `EVM_FORWARDER_ADDRESS`, `TRON_FORWARDER_ADDRESS`,
`EVM_MAX_FEE_GWEI_<CHAIN>`, `PIMLICO_SPONSORSHIP_POLICY_ID`, `PIMLICO_SOLANA_NETWORK`.

## Behaviour a screen should not contradict

- Sponsorship can silently fall back to shopper-pays after the merchant turned it on. `network_fee.reason`
  says why.
- Hook gas comes from the payment's proceeds and is outside the sponsorship budget.
- A hook call that reverted on chain fails at once, without the 3-day retry.
- A failed hook leaves the payment settled: the money is already in the contract.
- Copy-address payments are never gasless, whatever the policy says.
- Test and live have separate policies, usage, records and hook calls.

## Suggested screens

These are suggestions. Use what fits the dashboard.

- **Gas settings.** The policy fields, the store's default gas payer, a plain statement that nothing is
  sponsored until the policy is on. Changing it asks for step-up.
- **Usage this month.** Reserved, spent and remaining against the budget, the count, and a month picker.
- **Sponsorship log.** The records with status, chain, method, sponsor, estimate and actual cost, and the
  session or payment they belong to.
- **Hook delivery log.** For integrator stores: status, attempts, last error, contract, next retry.
- **Resend.** An action on a failed hook call.
- **Payment detail.** Who paid the network fee and, when the shopper did, why.

## Open items

See the "Gasless payments" section of `README.md`: nothing is deployed, no live Pimlico account is in
use and the sweep is off until the live checklist is done.
