# Tendr Checkout Core — Design

Date: 2026-10-25
Status: draft, reviewed by a builder check (awaiting the user's approval)
Builds on: the foundation spec (`2026-10-23-foundation-design.md`) and merchant accounts (`2026-10-25-merchant-accounts-design.md`), both merged to `main`.
Source of truth: the four Excalidraw diagrams in the repo root, and the user's answers in the 2026-10-25 brainstorms.

## Where this sits

1. Foundation (done)
2. Merchant accounts (done)
3. **Checkout core** (this document)
4. WooCommerce plugin. This is the first milestone: a pilot merchant takes a real payment end to end.
5. Gas service, relayer, payment links, themes, full dashboard
6. Shopify app, AI-agent API, and the AI layer (now a paid merchant feature)
7. FX solver

## Intent

A shopper pays a merchant's order in any token, on any chain that NEAR Intents supports. The merchant receives their chosen stablecoin in their own merchant account, and a signed webhook tells the store the order is paid. The shopper never sees swaps, solvers or gas mechanics. Tendr never holds the money.

## Goals

- **Session API.** A store (and in project 4, the WooCommerce plugin) creates a checkout session for an order: amount, currency, order reference, return URL. It gets back a session id and a client secret.
- **One checkout, three surfaces, all in the pilot:**
  - a hosted page;
  - a modal over the store's page;
  - an inline widget.
- **The shopper flow:**
  1. Pick a token and chain.
  2. Get a locked 1Click quote with the exact amount, fees included.
  3. Pay by connecting a wallet, or by sending manually to a one-time deposit address shown with a QR code.
  4. Watch live status: detected → converting → settled.
  5. See the completion screen with a transaction link, then return to the store. A modal or widget closes and signals the store instead.
- **Settlement into the merchant account.** Settlement goes into the merchant's account (NEAR Intents balance) in their chosen stablecoin, as set by the settlement proposal from project 2. `wallet` payout mode goes to a saved address.
- **Webhooks.** Signed, retried webhooks with a dashboard "resend".
- **Edge cases:**
  - quote expiry;
  - underpay;
  - overpay;
  - late deposits;
  - wrong-network warnings;
  - sanctioned senders.
- **Fees.** Tendr takes a small fee on each payment. The merchant chooses who pays fees and gas, as a store default plus a per-session or per-link override.
- **Test mode** works end to end without real money.

## Non-goals (this project)

- **AI features:** the route recommender, payment assistant and AI risk scoring. They are a paid merchant feature for later, decided by the user.
- **True gas sponsorship** (Pimlico for EVM and Solana, the gas-tron key for Tron). It comes with the gas service in project 5. The pilot uses reimbursement (see Fees and gas).
- **The WooCommerce plugin itself** (project 4). This project ships the API and the webhook contract the plugin will use.
- **Payment-link creation UI, theme editor, full dashboard** (project 5). The schema already holds payment links, and this project makes sessions respect a link's settings when one exists.
- **Automatic merchant-initiated refunds without signer approval** (deferred, decided in project 2).

## Anti-goals

- Tendr holding shopper or merchant funds at any point. Swaps go through 1Click straight into the merchant account.
- Marking an order paid before the merchant's money has actually settled, or from a browser signal alone. Only the server-verified settlement and the signed webhook count.
- Showing a shopper a price that can change after they've sent money.
- Auto-refunding funds from a sanctioned sender.
- A checkout that can be framed by a site the merchant hasn't registered.

## Decided by the user

- **Shopper flow:** as in Goals, in the user's own words: connect wallet or manual QR send, live status, return to store.
- **Surfaces:** hosted page, modal and widget, all for the pilot.
- **Refund address = the sending wallet.**
  - **Connected wallet:** its address is 1Click's `refundTo`.
  - **Manual send:** 1Click needs `refundTo` up front, so it is the merchant's NEAR account (`refundType INTENTS`). Tendr reads the sender from the deposit transaction, and a signer approves the return through project 2's refund proposal.
- **Overpay:** the extra goes back to the sender. Underpay also goes back (1Click refunds a short deposit).
- **Late money** (after the quote or session expired): refunded, and the order is never marked paid.
- **Fees:** Tendr takes a fee on each payment, kept small ("marginal").
- **Who pays fees and gas:** the merchant sets a default of merchant or shopper, and can override it per session or per payment link.
- **Gas for the pilot:** reimbursement is fine; true sponsorship waits for project 5.
- **Wallets:** all chains for the pilot (EVM, Solana, Bitcoin, Tron, NEAR), with the manual QR send as a universal fallback.
- **Sanctions:** screen the sender. A flagged payment is refused, never marked paid. For a manual send, the funds are **held for review** in the merchant account, not auto-refunded.
- **AI:** none in this project; it becomes a paid merchant feature later.

## The design

### 1. Session API (server-side, secret key)

- **`POST /v1/checkout/sessions`** (scope `sessions:write`, idempotent through the foundation's idempotency layer). Fields:
  - `amount`;
  - `amount_currency` (`USD` or an asset id);
  - `external_ref` (the store's order id, unique per merchant and mode);
  - `success_url` and `cancel_url`;
  - optional `metadata`;
  - optional overrides `fee_payer` (`merchant` | `shopper`) and `gas_payer` (`merchant` | `shopper`);
  - optional `payment_link_id`.

  It returns `{ id, client_secret, url (hosted page), expires_at, status }`. The settlement asset and destination come from the merchant's settlement config. Callers cannot set them.
- **`GET /v1/checkout/sessions/:id`** returns status, payments, refunds and totals.
- **Expiry and cancel:**
  - A session lives 30 minutes (my call, the brainstorm proposal) unless the store sets a shorter `expires_in`.
  - `POST /v1/checkout/sessions/:id/expire` lets the store cancel one.
- **Who-pays resolution, in this order:** session override → payment-link setting → merchant default. It is resolved and stored on the session at creation (`fee_payer`, `gas_sponsor`, `fee_bps` already exist on `sessions`).

### 2. The checkout page (shopper side, publishable key plus session client secret)

- **One Next.js route renders the checkout**, `/pay/[sessionId]` on the checkout subdomain.
  - The hosted page is that route opened directly.
  - The modal is the same route in an iframe overlay.
  - The widget is the same route in an inline iframe.
  - A tiny embed script (`tendr.js`, versioned and served by Tendr) creates the modal or widget and listens for `postMessage` events.
  - **User's decision (2026-10-25):** one page, framed, as proposed. If a wallet popup is blocked inside the frame, that wallet step opens in a popup window instead.
- **Framing** is allowed only on the merchant's registered domains, enforced by CSP `frame-ancestors`. The merchant registers domains in the dashboard; a minimal settings field is added in this project.
- **`postMessage` events to the host page:** `tendr:ready`, `tendr:status` (detected / converting / settled / refunded / expired / held), `tendr:complete`, `tendr:close`. They are sent only to the registered origin. They are informational: the store must rely on the webhook, not these events.
- **Screens:**
  1. Choose token. Every token and chain 1Click supports, searchable, with popular ones first and wallet balances shown once a wallet is connected.
  2. Quote: the exact amount to send, a fee breakdown (shown when the shopper pays fees), a countdown, and a network warning.
  3. Pay: connect a wallet, or the manual QR send with the deposit address, the exact amount and a "send only on <network>" warning.
  4. Status.
  5. Complete, late, refunded or held.

  The page uses Tendr's default look with the merchant's name and logo (themes come in project 5). Copy is plain: no "solver", "intent" or "gas" jargon.
- **Wallets:**
  - Reown AppKit (WalletConnect) for EVM, Solana and Bitcoin;
  - TronLink for Tron;
  - NEAR Wallet Selector for NEAR.

  A connected wallet sends the deposit transaction to the quote's deposit address from the shopper's own wallet. Tendr never signs for the shopper. Third-party wallet scripts are allowed on the checkout page only, not on dashboard signing pages.

### 3. Quotes (1Click)

- **`POST /v1/checkout/sessions/:id/quote`**, authenticated by the client secret. Input: origin asset, plus `refund_address` when a wallet is connected. It returns a quote with deposit address, `amount_in`, a fee breakdown and the deadline. The previous quote is replaced, and its deposit address stops being shown.
- **1Click call:**
  - `dry: false`, `swapType EXACT_OUTPUT`;
  - `destinationAsset` = the merchant's settlement stablecoin;
  - `recipient` = the merchant's account id, `recipientType INTENTS` (or the saved address in `wallet` payout mode);
  - `refundTo` = the connected wallet (`ORIGIN_CHAIN`), or the merchant's account (`INTENTS`) for a manual send;
  - `appFees` = Tendr's fee (see §5);
  - `deadline` = now + 12 minutes (my call, the brainstorm proposal), never after the session's expiry.
- **The quote is locked**: the shopper sends exactly `amount_in`. 1Click's `EXACT_OUTPUT` semantics give the merchant exactly the order amount. A shortfall is refunded, and an excess goes to `refundTo`. That implements the user's overpay and underpay rules with no extra logic.
- **Quote expiry:** when a quote expires with no deposit, the page fetches a new quote, and the shopper only notices if the price moved. Sessions are not affected until their own 30-minute expiry.
- **Test mode:** the simulated 1Click provider behind the foundation's provider seam (`livemode=false`). It returns deterministic quotes and lets tests and the dashboard simulate a deposit, underpay, overpay, late deposit and sanctioned sender. Settlement credits the merchant's test account through the mock intents verifier's `deposit` (project 2).

### 4. Watching payments

- **A worker job polls 1Click `GET /v0/status` per active deposit address**, every 5 seconds while the shopper's page is open and every 30 seconds otherwise (my call), until the payment reaches a terminal state or 24 hours have passed. The submit-deposit endpoint is called when the connected-wallet flow has a transaction hash, so detection is faster.
- **Mapping 1Click status to our state:**
  - `KNOWN_DEPOSIT_TX` / `PENDING_DEPOSIT` / `PROCESSING` → payment `DETECTED` → `PROCESSING`.
  - `SUCCESS` → payment `SETTLED`, session `SETTLED`.
  - `INCOMPLETE_DEPOSIT` → underpaid; the refund is 1Click's.
  - `REFUNDED` → payment `REFUNDED`.
  - `FAILED` → `REFUNDING` / ops alert.

  Amounts (`amountIn`, `amountOut`, `refundedAmount`) and transaction hashes are recorded on the payment. State changes go through the foundation's transition functions and the event log.
- **Settlement is verified, not only polled:**
  - For `recipientType INTENTS`, the watcher confirms the merchant account's intents balance increased by the expected amount (reusing project 2's balance read) before marking the payment settled.
  - For `wallet` payout mode, it confirms the destination transaction hash from 1Click.
- **Sender:** read from the origin-chain transaction (`originChainTxHashes`) for screening and for return-to-sender refunds.

### 5. Fees and gas

- **Tendr fee:** basis points from the merchant's fee plan (the foundation's `fee_plans`). Default 50 bps (0.5%, my call within "marginal"); a pilot plan may set 0. It is collected as a 1Click `appFees` entry to Tendr's fee account, so Tendr never touches the merchant's settlement. 1Click's own fee and network costs are passed through and shown as separate lines.
- **Fee payer = merchant** (the default): the quote targets `amount_out` = order total minus fees, so the shopper pays exactly the order total.
- **Fee payer = shopper**: `amount_out` = order total, so `amount_in` grows by the fees. The quote screen shows a "network & service fee" line.
- **Gas payer = merchant** (pilot reimbursement): the quote's `amount_in` is reduced by the estimated origin-chain network fee for the shopper's send, and that amount comes out of the merchant's received amount. 1Click's quote and the chain fee estimate give the number, and the reimbursement is capped per session (`gas_max_usd`, already in the schema). True sponsorship arrives in project 5.
- **Revenue:** every settled payment writes a `revenue_entries` row (Tendr fee, 1Click fee, network fee, gas reimbursement).

### 6. Edge cases

| Case | What happens | Shopper sees | Merchant / webhook |
|---|---|---|---|
| Quote expires, nothing sent | New quote, new address | Updated amount if the price moved | — |
| Underpay | 1Click refunds to `refundTo` | "Payment incomplete, returned to you" + retry within session | `payment.refunded` (reason `underpaid`) |
| Overpay | Order settles; 1Click sends the excess to `refundTo` | "Paid; the extra was returned" | `payment.succeeded` with `overpaid_amount` |
| Late deposit (after quote/session expiry) | Refunded; order never paid | "Arrived after it expired, being returned" | `payment.late` (never `succeeded`) |
| Manual-send refund (any of the above) | Lands in the merchant account; dashboard shows a "return to sender" item → project 2 refund proposal | "Your refund is being processed" | `refund.pending` → `refund.sent` |
| Sender is a known exchange | Refund held until the shopper provides an address (link in the refund email/page) | "Tell us where to send it" | `refund.needs_address` |
| Sanctioned sender, connected wallet | Refused at quote time; no money moves | "This wallet can't be used" | none |
| Sanctioned sender, manual send | Payment refused, funds held with a sanctions flag, no auto-refund | "We couldn't complete this payment" | `payment.held`; dashboard review item |
| Wrong network / wrong token | Prevented by warnings; if 1Click can't attribute it, ops runbook | warning before sending | — |

The known-exchange sender list is a maintained data file (my call). Its contents are left to the builder.

### 7. Screening

- Senders are checked against Chainalysis's free sanctions screening API (my call). The API key is stored as a foundation secret.
- **Connected wallets** are screened at quote time; **manual sends** are screened when the deposit is detected.
- Results go into `screening_results`.
- A hit blocks settlement marking. A `payment.held` event and a dashboard review item are recorded. Release or refund is a deliberate merchant decision, through a signer-approved refund proposal, with a confirmation warning.
- If the screening API is down, the payment is held for review, not settled. This fails closed (my call).

### 8. Webhooks

- **Endpoints:** merchants register them in the dashboard (`webhook_endpoints`, already modelled). Each has a signing secret stored in the KeyVault.
- **Events:**
  - `checkout.session.expired`;
  - `payment.detected`, `payment.processing`, `payment.succeeded`, `payment.refunded`, `payment.late`, `payment.held`;
  - `refund.pending`, `refund.sent`, `refund.needs_address`.
- **Payload:** `{ id, type, created, livemode, data }`, where `data` includes the session's `external_ref`.
- **Signature:** `Tendr-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`, Stripe-style.
- **Delivery:**
  - Through the foundation's outbox → dispatcher → `webhook_deliveries`.
  - Exponential backoff retries for up to 3 days (my call).
  - A dashboard "resend" button.
  - Deliveries are idempotent on the event id.

### 9. Dashboard (minimal, this project)

The project 2 dashboard gains:
- payments and sessions list and detail (amounts, fees, source token and chain, transaction links, refunds);
- the review queue (held and return-to-sender items, each linking to the refund proposal);
- webhook endpoints (create, secret reveal once, test send, delivery log with resend);
- registered checkout domains;
- fee and gas payer defaults.

### 10. Data model changes (builder fills the details)

- **Sessions:** `success_url`, `cancel_url`, `gas_payer`. The existing `fee_payer`, `gas_sponsor` and `gas_max_usd` columns remain.
- **Payments:** `sender_address`, `overpaid_amount`, `refunded_amount`, `oneclick_status`, `held_reason`.
- **Payment status:** add `HELD` (from `DETECTED`/`PROCESSING`; leaves only via a refund proposal → `REFUNDING`/`REFUNDED`). Session gains `HELD` correspondingly. Update the transitions in `@tendr/contracts`.
- **Merchants:** `checkout_domains`, `default_fee_payer`, `default_gas_payer`.
- **Refunds:** link to the project 2 `account_proposals` row; `destination`, `destination_chain`, `needs_address` status.

## Acceptance

- **Test-mode happy path:** create a session via the API → hosted page → choose a token → quote → simulate a deposit → status advances → settled. The merchant's test account balance rises, a `payment.succeeded` webhook arrives signed and verifies, and the dashboard shows the payment with its fee breakdown.
- **Edge-case tests:** each row of the §6 table, in test mode, with assertions on state, shopper copy, webhook events and refund proposals.
- **Modal and widget:** an embed test page frames the checkout on a registered origin and receives `postMessage` events; an unregistered origin is refused by CSP.
- **Who-pays:** all four fee/gas payer combinations produce the right `amount_in`/`amount_out`, and the session override beats the link setting, which beats the merchant default.
- **Mainnet:** a one-off verification on mainnet with a small amount. It is a manual script like project 2's: a real 1Click quote into a merchant contract account, settled, webhook delivered.

## Left to the builder

- Exact page layouts and copy, within the plain-language rule.
- Polling intervals beyond the stated defaults.
- The token list ordering and search.
- Field names in the API, following the foundation's conventions.
- The known-exchange list's format.

## Assumptions to verify early

1. 1Click `EXACT_OUTPUT` delivers the exact output to an intents recipient and sends overpay excess to `refundTo` (docs say so; confirm in a mainnet test).
2. Late-deposit behaviour (docs are silent): refunded vs swapped at the old terms. Test it; the design handles both, because a swapped late payment lands in the merchant account and goes through the return-to-sender path.
3. `appFees` on 1Click accrues to Tendr's fee account as expected, with authenticated pricing (JWT API key).
4. Reown AppKit, TronLink and NEAR Wallet Selector all work inside a cross-origin iframe (wallet popups and deep links from iframes are sometimes blocked). If not, the modal and widget fall back to opening the hosted page in a popup for the wallet step.
5. Chainalysis sanctions API terms allow this use; otherwise pick another screening provider.
6. 1Click accumulates a top-up deposit to the same address after `INCOMPLETE_DEPOSIT` before the deadline.
7. NEAR receipts of the 1Click settlement transaction contain an identifiable NEP-245/NEP-141 transfer event to the recipient with the amount.

## Decided by the user after the builder check (2026-10-25)

- **Surfaces:** one checkout page that the modal and widget frame, with a popup fallback for wallets blocked inside frames.
- **Return costs:** the cross-chain fee for returning money (overpay extra, underpay, late money, held-exchange refunds) is deducted from the amount returned. Leftovers worth under $1 are not returned: they stay with the merchant as a "small overpayment" and need no signer approval. The payment record and webhook (`overpaid_amount`, `kept_small_overpayment: true`) show this.
- **Shopper email:** the store may pass `customer_email` when it creates the session; the WooCommerce plugin always will. The checkout asks for an email only when it's needed (an exchange-sender refund) and the store didn't provide one. The email is used only for refund contact and receipts, stored on the session, and covered by the privacy page.

## Builder-check calls (my calls, 2026-10-25)

- **Session after an underpay refund:** if the session hasn't expired, it goes back to `PENDING_DEPOSIT` so the shopper can retry with a new quote. The refunded payment keeps its own record. A store cancel (`/expire`) moves the session to `EXPIRED` with `reason: canceled`; there is no separate state. `HELD` is added as described in §10. The `@tendr/contracts` transitions gain `PROCESSING → PENDING_DEPOSIT` (underpay retry only) and `→ HELD`.
- **What "merchant pays fees" covers:** everything — Tendr's fee, 1Click's fee and the swap spread. The quote is built in two steps: a dry quote prices the shopper's token in USD, then the real quote is sized so the shopper's `amountInUsd` equals the order total. The merchant receives whatever `amount_out` that gives. The fee screen shows nothing extra to the shopper; the payment record shows the merchant the exact deductions.
- **Pricing currency:** in the pilot, `amount_currency` must be `USD` or exactly the merchant's settlement asset. Other currencies are rejected (no FX source until project 7).
- **Funds held from a sanctioned sender:** they stay frozen. The dashboard offers no "release to merchant" action. A refund is possible only through a signer-approved proposal with a typed acknowledgement that legal clearance was obtained. Every action is recorded in the event log.
- **Tendr's fee account:** one per mode, `fees.tendr.near` / `fees.tendr.testnet`. It is itself a project 2 threshold-contract account with Tendr's operators as passkey signers, so Tendr's revenue gets the same protection as merchants' money. Test mode credits simulated fees to the testnet account through the mock verifier.
- **Checkout domains:** registered once per merchant and shared by test and live.

## Changes after external plan review (2026-10-25)

These supersede the earlier text where they differ.

1. **Settlement is verified per transfer.** The watcher takes 1Click's `destinationChainTxHashes`, fetches that NEAR transaction's receipts, and requires a transfer event of the settlement asset, for at least `amount_out`, to the merchant account. In `wallet` mode it checks the destination chain's transfer the same way. Balance deltas are never used, because other payments, withdrawals and sweeps move the balance.
2. **`screening_pending`.** When screening is unavailable, the payment waits in `SCREENING_PENDING` (not `HELD`). Screening is retried with backoff for up to 6 hours. `allow` settles normally; `block` → `HELD`. If screening is still unavailable after 6 hours, the merchant gets a review item; it is not a legal hold.
3. **What a hold does (user's decision: stay non-custodial).** Tendr cannot freeze money in a merchant account. A hold:
   - keeps the order unpaid;
   - sends `payment.held` instead of a paid webhook;
   - alerts all signers with a clear notice: "These funds came from a sanctioned address. Tendr cannot freeze them; you are responsible for not using them; get legal advice."

   The dashboard, the email and the docs say this plainly. Refunds still need the typed legal acknowledgement.
4. **Order references after expiry.** `external_ref` is unique only among sessions in `PENDING_DEPOSIT`, `PROCESSING`, `SCREENING_PENDING` and `SETTLED`. An expired, late or held order can get a new session.
5. **Hosted URL.** The session `url` includes the client secret in the fragment: `…/pay/{id}#cs=<client_secret>`.
6. **Optional refund address for manual sends.** The quote screen asks "Your address on <network>, in case we need to send money back" (optional, with an address-format check).
   - When it is given, it becomes 1Click's `refundTo` (`ORIGIN_CHAIN`), and underpay, overpay and late refunds happen directly without merchant approval.
   - When it is empty, refunds use the merchant-approval path.
   - The provided address is screened at quote time.
7. **Every detected sender is screened** on detection, including connected-wallet flows, because the sender may differ from the connected wallet.
8. **Underpay top-up.** While the quote is still live and 1Click reports `INCOMPLETE_DEPOSIT`, the checkout first offers "Send the remaining X to the same address". The refund-and-reopen path only applies after the quote deadline. Whether 1Click accumulates deposits is added to "Assumptions to verify early"; if it does not, the top-up option is turned off by a flag.
9. **Gas reimbursement is deliberate** for the pilot. Pimlico sponsorship arrives with the gas service in project 5. The checkout discloses before payment that leftovers under $1 are not returned.

## Carried decisions from earlier projects

- Merchant accounts (project 2) provide:
  - the settlement destination (`set_settlement` proposal mirror);
  - the merchant's intents account;
  - signer-approved refund proposals;
  - the watcher;
  - notices.
- The foundation provides sessions, quotes, payments and refunds tables, state transitions, the event log, the outbox and the KeyVault.
