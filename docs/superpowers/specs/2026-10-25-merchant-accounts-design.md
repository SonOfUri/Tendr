# Tendr Merchant Accounts — Design

Date: 2026-10-25
Status: draft, reviewed by a builder check (awaiting the user's approval)
Builds on: `docs/superpowers/specs/2026-10-23-foundation-design.md` (merged to `main`)
Source of truth: the four Excalidraw diagrams in the repo root, and the user's answers in the 2026-10-25 brainstorm.

## Where this sits

**Project order changed (user's decision, 2026-10-25):** merchant accounts now comes before checkout core, because checkout refunds land in the merchant's NEAR account.

1. Foundation (done)
2. **Merchant accounts** (this document)
3. Checkout core. Decisions already taken for it are recorded under "Carried into checkout core" at the end of this document.
4. WooCommerce plugin. This is the first milestone: a pilot merchant takes a real payment end to end.
5. Gas/relayer/payment links/themes/full dashboard
6. Shopify app, AI-agent API. The JS widget moved into project 3; see the carried decisions.
7. FX solver

## Intent

A merchant who is new to crypto signs up and gets a store money account that only the store's own people can move money out of. Tendr can never move a merchant's money, even if Tendr's servers are compromised. The account is ready to receive checkout settlement and refunds in project 3.

## Goals

- **Signup.** The merchant signs up with email and a passkey (Face ID / Touch ID / Windows Hello). They never see a seed phrase, a wallet app or gas.
- **The NEAR account.** Every merchant gets a NEAR account controlled by a per-merchant **threshold contract**. The contract holds the store's balance inside NEAR Intents and moves money only with N-of-M signer approvals. N is set by the owner.
- **Two keys before going live.** A store cannot take live payments until it has at least two keys registered (user's decision). Two signers' passkeys count, and so does one passkey plus the recovery key.
- **Team.** The owner invites people by email and gives each a role. Only users marked as signers hold a key on the account.
- **Money out.** Refund and withdrawal requests are approved by signers with their passkeys. Withdrawals are crypto-only for the pilot.
- **Saved addresses.** Withdrawals go only to saved addresses. Adding a new address needs approval at the threshold, then waits 24 hours before it can be used.
- **Recovery.** A recovery key can replace lost signers after a 72-hour delay, with notice to every signer. It can never move money.
- **Auto-sweep and limits** (from the diagram, "Controls: allowlist, limits, auto-sweep"). Auto-sweep can only send to a saved address. Limits are enforced by the contract.
- **Test mode** works end to end, Stripe-style.

## Non-goals (this project)

- Checkout, quotes, payment watching and webhooks. These are project 3. Refund *requests* are created by checkout in project 3; this project builds the approval and execution path, and tests it with fixture refunds.
- The full dashboard: analytics, themes, payment links. That is project 5. This project ships only the screens it needs (listed in §9).
- Bank payouts, off-ramps, KYC and KYB. User's decision: crypto-only withdrawals, email plus keys is enough for the pilot.
- The narrow automatic-refund permission. This is option 2 from the brainstorm, deferred. For the pilot, merchants approve refunds themselves (user's decision).

## Threat scope (user's decision)

"Tendr can never move the money" holds even when **Tendr's website is compromised**, not only its backend and relayer. A passkey prompt cannot show what is being signed, so a hostile dashboard could show one summary and collect a signature over a different action. The contract therefore enforces these limits itself:

- **Unsaved-destination refunds.** A refund to an address that isn't saved fits under a small on-chain daily cap per asset. The cap is set by proposal; its default is left to the builder, sized for pilot refunds. A refund above the cap waits 24 hours, and every signer is emailed with the decoded destination and amount. Any signer can cancel during the wait.
- **Swap withdrawals.** A withdrawal that needs a 1Click swap, and so sends money to an address Tendr supplies, waits 24 hours, with the same notice and cancel.
- **Everything else** either goes to saved addresses, which already wait 24 hours when added, or changes security settings, and those changes take effect only after notice.
- **Notice reaches signers outside the dashboard.** Emails are sent by the worker from chain events, so a compromised website cannot suppress them.
- **The website is hardened anyway:** a strict CSP, no third-party scripts on signing pages, and Subresource Integrity on assets. This is defense in depth, not the guarantee.

## Anti-goals

- Tendr holding any key, at any level, that can move merchant funds or change signers. This includes relayer keys, `funding-near`, function-call keys and the KMS.
- A threshold that can be bypassed: by one signer for N>1, by the recovery key, by the relayer, or by Tendr's database.
- A seed phrase anywhere in the merchant's experience.
- A recovery path that lets someone take over an account silently.
- Test-mode keys or accounts able to touch mainnet funds.

## Decided by the user

- Non-custodial: only the merchant can move the money.
- Merchants are new to crypto, so signing uses passkeys.
- At least two keys are required before taking payments.
- The account is multi-user. The **owner sets the approval threshold**.
- No business verification for the pilot: email plus keys.
- Payouts are crypto-only for now.
- Refunds for the pilot are approved by the merchant. Automatic refunds come later, through a narrow permission.
- Refunds of manual-send checkout payments go through the merchant's NEAR account (refundType `INTENTS`). Merchant accounts come before checkout core.

## The design

### 1. On-chain architecture

These findings are verified against nearcore and near/intents source on 2026-10-25; see "Assumptions to verify early".

- **One threshold contract per merchant**, deployed to the merchant's NEAR account. The account has **no full-access keys** after setup, so the contract is the only thing that can act for it.
- **Funds live in NEAR Intents** (`intents.near`). The contract owns the balance through the verifier's *predecessor authorization*: `mt_transfer`, `mt_withdraw` and `ft_withdraw` with 1 yocto attached, called by the contract itself. No public keys are registered in the verifier (`add_public_key` is unused), so nothing outside the contract can sign for the balance.
- **Signers are passkeys verified inside the contract.**
  - The contract checks WebAuthn assertions with the `p256_verify` host function (protocol ≥ 85) or `ed25519_verify`.
  - Reuse the WebAuthn verification crate from `near/intents` (`crates/signatures/webauthn`). It enforces low-s, the challenge, the `rpIdHash`, the origin and the user-verification (UV) flag.
  - Signer keys are contract state. They are not NEAR access keys.
- **Approval model.**
  - A *proposal* is one action plus its parameters: withdraw, refund, add or remove a saved address, add or remove a signer, change the threshold, set limits, set auto-sweep, rotate the recovery key.
  - Each proposal gets a contract-assigned id and a nonce. Signers sign a hash of `(contract id, proposal id, action, params, nonce)`.
  - Approvals can be submitted one at a time. A proposal executes once it holds N distinct valid signer approvals, and it expires after a set time (builder's choice, default 7 days).
- **Proposals start with a signer (my call).** A non-signer's request stays off-chain, in Postgres, as a draft until a signer approves it. That first signer's assertion creates the proposal on chain. The contract therefore accepts proposals only with a valid signer assertion, which gives Tendr no privileged role and closes the storage-spam path.
- **Relayer key (my call).** A new named KMS key, `relayer-accounts` (Ed25519), submits proposals and approvals. It holds only gas money. This amends the foundation's named-key list, which reserves `relayer-near` for project 5's notify-only work and `funding-near` for account creation.
- **The relayer only pays gas.** Tendr's relayer submits proposals and approvals and pays for them. Every money movement is a call the *contract* makes, with parameters fixed by the approved proposal. A compromised relayer can delay things but cannot redirect funds.
- **Account naming (my call).** Accounts are named `<slug>.tendr.near` (and `<slug>.tendr.testnet`). The diagram shows `mystore.near`, but a top-level name per merchant is costly; a sub-account under Tendr's account gives a readable name. `funding-near` creates the sub-account, deploys the contract, initializes it with the signer keys, and **deletes its own key from the new account in the same transaction**.
- **Deployment (my call).** Accounts point at a published global contract (NEP-591) by code hash instead of each carrying its own copy of the code. That keeps per-merchant storage cost small, and Tendr pays it from `funding-near` within the foundation's spend caps. The exact cap numbers are left to the builder.
- **Upgrades.** The contract is upgradeable only through a proposal at the threshold. Tendr publishes new versions; each merchant's signers choose to adopt them. Tendr cannot push an upgrade.
- **Audit gate.** The threshold contract must be independently audited before any live merchant holds real funds. Test mode on testnet can run unaudited.

### 2. Keys and roles

- **Roles** are the diagram's existing enum: `owner`, `admin`, `finance`, `viewer`. Mapping from the brainstorm (my call):

  | Role | Can do |
  |---|---|
  | `viewer` | Read everything |
  | `finance` | Request refunds, withdrawals and new saved addresses |
  | `admin` | Everything `finance` can, plus team and store settings, and resending webhooks |
  | `owner` | Everything `admin` can, plus proposing threshold and signer changes |

- **One person, many stores (my call).** A login belongs to a person: a new `users` table with email and passkeys. `merchant_users` becomes that person's membership in one store. A person can be in several stores and switch between them, Stripe-style, and the same passkey signs for every store they belong to.
- **Signer** is a separate flag on a membership. Any user except a `viewer` can be made a signer, and adding a signer is itself a proposal. A signer can approve proposals.
- **Requesting vs approving.** A user without the signer flag can request but not approve. A signer who creates a proposal also approves it in the same step, which counts as one of the N approvals.
- **RP ID (user's decision): `usetendr.tech`.** The diagrams show `usetendr.xyz`; the user confirmed `.tech` is final. Passkeys belong to `usetendr.tech`, so the dashboard and checkout subdomains share them. The contract pins the RP ID hash, and keeps a list of allowed origins that can be changed by proposal. Testnet uses the same RP ID; a `localhost` RP ID is used only for local development.
- **Passkeys.** One WebAuthn credential per user per device, under Tendr's RP ID. The same credential logs the user into the dashboard and signs proposals; the contract checks the RP ID hash and challenge, so a login assertion can never be replayed as an approval. A signer may register several devices, and each device's key counts toward that *one* signer. Distinct approvals are counted per signer, not per key.
- **Recovery key** (the diagram's "guardian").
  - It is generated in the merchant's browser and shown once as a printable recovery kit (a code plus a QR). Only its public key is stored on chain. It is an Ed25519 key. Tendr never sees the private part.
  - It can do one thing: start a *recovery* that replaces the signer set and threshold.
  - A recovery executes 72 hours after it is started, unless any current signer cancels it. Every signer is emailed when it starts and again 24 hours before it executes.
- **Two-key rule.** The store goes live only when `signers + recovery key ≥ 2` and the threshold is at most the number of signers. The recovery key never counts toward the threshold.
- **Threshold changes.** The owner proposes, and approval needs the *current* threshold. The contract rejects a threshold greater than the number of signers.
- **`AccountKey` table.** It mirrors on-chain signer and recovery keys for display and lookup. It is not authoritative; the contract is. Use `kind = passkey`, and add `recovery` to `AccountKeyKind`. `fn_call` keys are not used by this project.

### 3. Signup and onboarding

1. The merchant enters an email. A magic link verifies it.
2. They create a passkey. The dashboard session starts and the `Merchant` and owner `MerchantUser` rows are created.
3. They choose a store name; the slug is derived from it, and the `near_account_id` is reserved.
4. **Second key, required before going live.** The merchant either adds another device or another person as a signer, or creates the recovery kit (download or print, then confirm by typing back a few characters).
5. The account service creates `<slug>.tendr.testnet` straight away, so test mode works from minute one. The mainnet account `<slug>.tendr.near` is created when the merchant first switches to live and the two-key rule holds.
6. The dashboard shows an "Account ready" state with the account id and the test and live balances.

### 4. Money out

Every money movement is a proposal, and every proposal follows the same flow:

- **Request.** The user fills in a form. The API validates it against the rules mirrored in the database (saved address, limits) for fast feedback, then creates the proposal on chain through the relayer. On-chain validation is the authority.
- **Approve.**
  - Signers see pending proposals in an *Approvals* inbox and are emailed about each new one.
  - Approval shows a plain summary, for example "Withdraw 1,200 USDC to Coinbase (0x91…44) on Base", then a passkey prompt.
  - The browser builds the assertion, and the relayer submits it.
- **Execute.** When the Nth approval lands, the contract performs the action and emits an event. The worker watches the account's on-chain events and records them through the foundation's event log, which drives notifications and the dashboard.

**Refunds.**
- Refunds are created by checkout in project 3, or by a merchant from a payment. A refund's destination is the original sender's address, taken from the payment record. A refund proposal is a cross-chain withdrawal from the intents balance to that address on the origin chain and token.
- Refunds may go to a non-saved address, because the destination is pinned to the payment's sender and not typed by a user. The contract cannot check that pinning, so the dashboard shows it. *(My call: the 24-hour saved-address rule is skipped for refunds. Refunds still need the threshold, and the summary states "back to the sender of payment pay_…". The on-chain daily cap and the 24-hour wait above it are described under "Threat scope".)*
- If the sender is on a known-exchange list, the refund is held: the dashboard asks the merchant for the shopper's address. Building that list is part of project 3.

**Withdrawals.** These are crypto only. The merchant chooses a saved address, the token and chain to receive, and an amount.
- The withdrawal mechanism is chosen per asset: PoA `ft_withdraw`/`mt_withdraw` with the destination in the memo, or a 1Click swap from the intents balance when the requested token or chain differs from what is held. The 1Click route needs verification; see "Assumptions to verify early".

**Saved addresses** (`payout_allowlist`).
- Adding one is a proposal. Once approved, it becomes usable 24 hours later (`activeFrom`). Removing one is a proposal that takes effect immediately.
- The list lives in contract state, and the table mirrors it.

**Limits** (my reading of "limits" in the diagram).
- Caps are set per asset in that asset's smallest units (my call). The contract has no price oracle and shouldn't depend on one. Merchants mostly hold stablecoins, so the dashboard shows the caps in dollars.
- Optional per-withdrawal and per-day caps, set by proposal and enforced by the contract. Raising a cap takes effect after 24 hours; lowering it takes effect immediately.
- Refunds are capped by the original payment amount. The contract can check this only if the payment is recorded, so for the pilot the cap is enforced in the API and the summary.

**Auto-sweep** (from the diagram).
- Optional, and set by proposal: "when the balance of asset A exceeds X, send everything above Y to saved address Z".
- Once set up, anyone may trigger a sweep (the relayer does it on a schedule). The contract checks the rule and the destination, so no signer is needed per sweep and Tendr still cannot choose where the money goes.

### 5. Settlement destination

The diagram's `settlement_configs.payout_mode` has two values:

- `intents` (default): checkout settles into the merchant's intents balance (`recipientType INTENTS`, recipient = merchant account id).
- `wallet`: checkout settles straight to an external address. This bypasses the account's controls, so choosing it requires the address to be a saved address *(my call)*.

The settlement configuration (destination stablecoin and mode) is a setting owned by this project. Changing it is a proposal because it redirects future money. Project 3 reads it.

### 6. Test mode

- **Test and live contracts (my call).**
  - **The live contract is authoritative.** It is created at go-live, seeded with the store's current signers, threshold and recovery public key, and from then on every security change is a proposal on it.
  - **The test contract is a sandbox.** It also accepts a Tendr testnet admin key that mirrors the live signer set. This gives Tendr power over the test contract, which is acceptable because testnet holds no real money; the live contract never has that key. Signers are never asked to approve a change twice.
  - **One recovery kit** (one key) covers both, since the networks are separate.
  - **The signer flag lives on the person**, not per mode.
- The `livemode` flag decides which account is used: `<slug>.tendr.testnet` for test, `<slug>.tendr.near` for live.
- 1Click has no testnet (foundation finding). In test mode, the intents balance and withdrawals are simulated behind the provider seam from the foundation: `livemode = false` uses the simulated provider. The threshold contract still runs on NEAR testnet for proposals, approvals, recovery, saved addresses and limits, so the signing flow is real in test mode.
- Whether a testnet intents verifier exists is unknown; see "Assumptions". If it exists, test mode may use it.

### 7. Services and API

- **Account service** (`apps/api`):
  - account creation and contract deployment through `funding-near`, with spend caps as in the foundation spec;
  - building proposals and the challenges signers sign;
  - relaying approvals;
  - watching the chain and mirroring contract state into Postgres.
- **Merchant service:** signup, team, roles, signer flags, invites, saved-address and settings requests.
- **Dashboard auth:**
  - WebAuthn login, plus magic links for invites and email verification;
  - HttpOnly secure session cookies, mapped to the gateway's existing `dashboard_user` principal;
  - role checks in the gateway's scope layer.
- **Endpoints** (paths are the builder's choice; everything goes through the existing gateway):
  - signup and auth;
  - team: invite, role, signer flag;
  - proposals: create, list, get, approve, cancel;
  - recovery: start, cancel, status;
  - saved addresses, limits, auto-sweep;
  - balances: read from chain or the simulated provider, cached briefly.
- **Events.** Contract events go into `events` (append-only), for example `account.proposal.created`, `account.proposal.approved`, `account.proposal.executed`, `account.recovery.started`, `account.recovery.cancelled`, `account.signer.added`. They drive email notifications through the foundation's outbox and dispatcher.

### 8. Data model changes

New tables (the diagram has none of these; my call):

- `account_proposals`: id, merchant_id, livemode, on-chain proposal id, kind, params (json), status (`pending` / `executed` / `cancelled` / `expired` / `failed`), created_by, created_at, executed_at, tx hash.
- `account_approvals`: proposal_id, signer user id, key id, tx hash, created_at.
- `recovery_requests`: merchant_id, livemode, started_at, executes_at, status, tx hashes.
- `merchant_invites`: merchant_id, email, role, token hash, expires_at, accepted_at.
- `webauthn_credentials`: user_id, credential id, public key, sign count, transports, device label, created_at, last_used_at.
- `merchant_accounts`: merchant_id, livemode, near_account_id, contract version, threshold, created tx, status.

Changes to existing tables:

- New `users` table (person: id, email unique, email_verified_at). `webauthn_credentials.user_id` references it.
- `merchant_users`: becomes membership. Add `user_id` and `is_signer`, and drop the per-membership email in favor of `users.email`. Repurpose `mfa_enabled`, or drop it, since a passkey already is the second factor.
- `account_keys`: add `user_id` (nullable for the recovery key) and `livemode`. Add `recovery` to the kind enum.

All new rows follow the foundation's rules: prefixed ULIDs, `livemode`, composite tenant foreign keys, scoped clients, and state changes inside `tenantTransaction`.

### 9. Screens in this project

All screens are in `apps/web` (Next.js) and are minimal; project 5 restyles them:

1. Signup: email, then passkey.
2. Store name.
3. Second key: add a device or person, or download the recovery kit.
4. Account home: test and live balances, account id, "Go live" checklist.
5. Team: invite, roles, signer flag.
6. Approvals inbox, plus a proposal detail page with the approve button.
7. Withdraw.
8. Saved addresses.
9. Security: threshold, limits, auto-sweep, recovery kit status.
10. Recovery: start (with the recovery kit) and cancel, plus a banner while a recovery is pending.

## Acceptance

- **Signup in test mode.** A new merchant signs up, creates a passkey, adds a recovery kit, and has a testnet account with the threshold contract deployed. The deploying key is no longer on the account.
- **Contract tests**, in Rust unit tests plus testnet integration tests:
  - wrong-key, replayed, wrong-challenge, wrong-RP and high-s assertions are rejected;
  - the same signer approving twice counts once;
  - N−1 approvals never execute;
  - a threshold above the signer count is rejected;
  - the recovery key cannot move funds;
  - recovery is cancellable by any signer and executes only after 72 hours;
  - a new saved address is unusable for 24 hours;
  - limits and auto-sweep rules are enforced;
  - the relayer cannot change any parameter of an approved action;
  - an unsaved-destination refund over the daily cap and a swap withdrawal both wait 24 hours and can be cancelled by any signer;
  - an upgrade needs the threshold.
- **Intents integration**, on mainnet with a small amount, as a one-off verification like the foundation's KMS check. The contract account receives a 1Click swap with `recipientType INTENTS`, and executes a threshold-approved withdrawal to an EVM address.
- **API tests:** roles and scopes; invites; a non-signer cannot approve; the go-live check enforces the two-key rule; test and live accounts are isolated.
- **Playwright** test with a virtual WebAuthn authenticator: signup → recovery kit → withdraw request → approve → executed (simulated provider).

## Left to the builder

- Contract language and framework: Rust with near-sdk is assumed, reusing `defuse_webauthn`.
- Proposal expiry duration and storage layout.
- How the worker watches the chain (indexer, RPC polling, or a NEAR Lake-style feed).
- Email provider and templates.
- Exact endpoint paths and payload shapes.
- Balance caching TTL.

## Assumptions to verify early

1. **`p256_verify` works on mainnet** for the deployed contract. It is gated at protocol 85, the stable version is 89, but this was read from nearcore source and not yet called on mainnet.
2. **1Click delivers to a contract account id** with `recipientType INTENTS` and refunds to it with `refundType INTENTS`. The docs don't constrain this; a small live swap proves it.
3. **Cross-chain withdrawal from an intents balance:** whether PoA `ft_withdraw` with a `WITHDRAW_TO:` memo covers the pilot's assets, and whether 1Click accepts `depositType INTENTS` for withdrawals that need a swap.
4. **Sub-account creation and the same-transaction key deletion** under `tendr.near` using a KMS-held `funding-near` key.
5. **Whether a testnet intents verifier exists.** If not, test mode simulates balances, as §6 describes.
6. **Storage deposits** (NEP-145) needed for withdrawals of each token.

If 1 fails, the fallback is verifying P-256 in Wasm, which is costlier, or restricting signers to Ed25519 passkeys. Raise it with the user before choosing. If 2 fails, stop and raise it, because checkout settlement and refunds depend on it.

## Carried into checkout core (project 3)

Decided by the user on 2026-10-25; recorded here so they aren't lost:

- **Shopper flow** (the user's description): choose "Pay with crypto (tendr)" → session for the Woo order → pick a token or chain → locked 1Click quote → connect a wallet *or* send manually to a one-time deposit address with a QR code → live status (detected → converting → settled) → complete with a transaction link → back to the store. A signed webhook marks the order paid.
- **Three surfaces in the pilot:** hosted page, modal and inline widget. My proposal, not yet confirmed: one checkout page, which the modal and widget frame. Framing is allowed only on domains the merchant has registered.
- **Refund address = the sending wallet.**
  - Connected wallet: it is passed as `refundTo`.
  - Manual send: 1Click needs `refundTo` up front, so `refundTo` is the merchant's account (`refundType INTENTS`). The sender is then read from `originChainTxHashes`, and the merchant approves the return (this project's refund proposal).
  - Refunds to known-exchange senders are held until the shopper supplies an address.
- **Still open for project 3:** overpay policy, late-deposit behavior (1Click docs are silent; test it), quote and session timers (proposed 12 and 30 minutes), and edge-case UX.
