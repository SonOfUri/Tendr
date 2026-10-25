# Tendr Merchant Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant new to crypto signs up with email and a passkey and gets a NEAR money account that only their own signers can move money out of: a threshold contract holding a NEAR Intents balance. The account has team roles, approvals, saved addresses, limits, auto-sweep and 72-hour recovery, works in test mode, and comes with the dashboard screens to drive it.

**Architecture:**
- **One Rust contract per merchant.** It is published once as a NEAR global contract and owns the merchant's NEAR Intents balance by predecessor auth.
- **Signers approve with WebAuthn passkeys,** which the contract verifies itself.
- **Every outflow and every security change is a proposal.** It executes on N distinct signer approvals bound to the current *signer epoch*. Risky outflows sit behind on-chain timelocks.
- **`apps/api` does the off-chain work.** It handles signup, auth, team and drafts, builds the exact bytes signers sign, relays transactions with a gas-only KMS key, and mirrors on-chain state. Its worker reconciles chain state and sends notices.
- **`apps/web` adds the dashboard screens.**

**Tech Stack:**
- **Contracts:** Rust (stable), `near-sdk` 5.x, `near-workspaces` (sandbox integration tests), `cargo-near` reproducible builds via Docker. The WebAuthn checks come from `near/intents` `crates/signatures/webauthn`, pinned by git rev.
- **API:** the existing Node 22 / Fastify 5 / Prisma 6 / BullMQ stack, plus `@simplewebauthn/server` 13, `@near-js/*` (transactions, providers, crypto) and `borsh`.
- **Web:** Next.js 15, plus `@simplewebauthn/browser` 13 and Playwright with a CDP virtual authenticator.

**Spec:** `docs/superpowers/specs/2026-10-25-merchant-accounts-design.md`, approved 2026-10-25. Read it alongside this plan; the foundation spec and plan are background.

## Global Constraints

**Commits and attribution**
- No commit or PR may contain a `Co-Authored-By: Claude…` trailer or a "Generated with Claude Code" line (user's standing instruction). Commits carry only the user's authorship.

**Custody**
- Tendr never holds a key that can move merchant funds or change signers. Merchant NEAR accounts have **zero access keys**, from creation onward.
- Tendr's keys:
  - `funding-near` only creates accounts (spend-capped);
  - `relayer-accounts` (new, Ed25519) only pays gas for contract calls.
- No private key, recovery secret or full-access key is ever stored in Postgres or logs. The recovery kit's private part exists only in the merchant's browser and on paper.

**Contract rules**
- The live contract is authoritative. Postgres mirrors on-chain state for display and fast validation; the contract re-checks everything.
- Fixed values:

  | Constant | Value |
  |---|---|
  | `SAVED_ADDRESS_DELAY` | 24 h |
  | `TIMELOCK_DELAY` | 24 h (refunds over the cap, swap withdrawals, limit raises) |
  | `RECOVERY_DELAY` | 72 h |
  | `PROPOSAL_TTL` | 7 days |
  | `RECOVERY_NOTICE_BEFORE` | 24 h before execution |

  All times are nanoseconds of `env::block_timestamp()` on chain.
- **Domain:** RP ID `usetendr.tech` in production. Local dev and tests use RP ID `localhost` with origin `http://localhost:3000`.
- **Account names:** `<slug>.tendr.near` (live) and `<slug>.tendr.testnet` (test). The parent accounts and intents verifier ids are env config:

  | Env var | Value |
  |---|---|
  | `NEAR_PARENT_ACCOUNT_LIVE` | `tendr.near` |
  | `NEAR_PARENT_ACCOUNT_TEST` | `tendr.testnet` |
  | `INTENTS_CONTRACT_LIVE` | `intents.near` |
  | `INTENTS_CONTRACT_TEST` | `intents-mock.tendr.testnet` (our mock verifier, Task 4) |

- **Amounts** are on-chain smallest units: `u128` in Rust, `Decimal(78,0)` in Postgres, strings in JSON. Limits are per asset id (an intents token id such as `nep141:usdc.near`).

**Approval encoding**
- The bytes a signer signs are defined once, in Task 2. Rust and TypeScript are tied together by shared test vectors in `onchain/merchant-account/test-vectors/approval-payloads.json`.

**Foundation rules still apply**
- Prefixed ULIDs; `livemode` on per-mode rows; composite tenant foreign keys; scoped clients; state changes in `tenantTransaction`; append-only `events`; error envelope `{ error: { code, message, requestId, details? } }`.
- Nothing is deployed to mainnet. Testnet deployment of the global contract and mock verifier is a manual script (Task 15). Mainnet checks are a manual script the user runs (Task 15). The contract must be audited before any live merchant holds funds.

**Toolchain and environment**
- No new host installs:
  - Wasm builds run in Docker (`cargo near build reproducible-wasm`).
  - Native `cargo test` uses the existing Rust toolchain.
  - `near-workspaces` downloads its own sandbox binary.
- Local dev must keep working without GCP credentials or network access to NEAR. API tests use the `FakeNearClient` (Task 8). Only `onchain/` sandbox tests and the manual scripts talk to a NEAR node.

## Review Focus

These are the five failure modes most likely to bite a user. Each one's test lives in the task named.

1. **A person who signs for two stores.** An assertion for store A's proposal is relayed to store B's contract with the same passkey and the same proposal bytes, and B must reject it. The contract id is in the signed payload. Test in Task 2.
2. **A signer is removed, or the threshold changes, while proposals are pending.** Earlier approvals must stop counting, so a removed signer's approval can never help execute. The signer epoch is bumped on every signer, threshold or recovery change. Tests in Tasks 2 and 5.
3. **Many small unsaved-address refunds** that together exceed the daily cap. The cap is a rolling 24-hour sum per asset: the refund that crosses it is timelocked, not executed. Test in Task 4.
4. **A saved address removed, or a limit lowered, while a withdrawal to it is pending or timelocked.** Execution must re-check at execute time and fail. Test in Task 4.
5. **An invite sent to an email that already has a Tendr login** (an owner of another store). Accepting joins the existing person, keeps their passkeys, and creates no duplicate user. Test in Task 9.

---

## File Structure

```
onchain/                                   # new Cargo workspace (Rust)
  Cargo.toml                               # Task 1
  rust-toolchain.toml                      # Task 1
  scripts/build.sh                         # Task 1  (Docker reproducible build of both crates)
  merchant-account/
    Cargo.toml                             # Task 1  (features: testnet-admin)
    src/lib.rs                             # Task 2  contract entry, state, views
    src/webauthn.rs                        # Task 1  assertion verification
    src/action.rs                          # Task 2  Action enum (borsh) + validation
    src/approval.rs                        # Task 2  payload hashing, signer epoch
    src/money.rs                           # Task 4  withdraw/refund/sweep/limits
    src/saved.rs                           # Task 3  saved addresses
    src/recovery.rs                        # Task 5  recovery + upgrade + testnet admin
    src/events.rs                          # Task 2  NEP-297 events
    test-vectors/approval-payloads.json    # Task 2  (written by a Rust test, read by TS)
    tests/sandbox.rs                       # Task 6  near-workspaces integration
  mock-intents/
    Cargo.toml, src/lib.rs                 # Task 4  test verifier (records calls, holds balances)
packages/contracts/src/
  accounts.ts                              # Task 7  roles→permissions, proposal kinds/states
apps/api/
  prisma/schema.prisma + migration         # Task 7
  src/keyvault/{types,keys}.ts             # Task 7  add `relayer-accounts`
  src/near/                                # Task 8  rpc, tx build/sign, account creation, fake
  src/accounts/encoding.ts                 # Task 10  borsh Action + payload hash (matches vectors)
  src/accounts/proposals.ts                # Task 10  drafts, create/approve/relay, local validation
  src/accounts/accounts.ts                 # Task 11 provisioning, go-live, test mirror
  src/accounts/watcher.ts                  # Task 12 reconcile chain → mirror + events
  src/auth/{webauthn,session,magic-link,mailer}.ts   # Task 9
  src/merchants/{signup,team,invites}.ts   # Task 9
  src/gateway/{principal,auth}.ts          # Task 9 (user_session principal, permissions)
  src/routes/{auth,merchants,team,accounts,proposals,recovery}.ts  # Tasks 10–12
  src/jobs/account-notices.ts              # Task 12
  scripts/onchain-publish-testnet.ts       # Task 15
  scripts/verify-merchant-account-mainnet.ts  # Task 15
apps/web/src/
  lib/{api,webauthn,recovery-kit}.ts       # Task 13
  app/(auth)/{signup,login,invite}/…       # Task 13
  app/dashboard/{…}                        # Tasks 13–14
  e2e/merchant-accounts.spec.ts            # Task 14
```

---

### Task 1: `onchain/` workspace and WebAuthn verification

**Files:**
- Create: `onchain/Cargo.toml`, `onchain/rust-toolchain.toml`, `onchain/scripts/build.sh`, `onchain/merchant-account/Cargo.toml`, `onchain/merchant-account/src/lib.rs` (module stubs), `onchain/merchant-account/src/webauthn.rs`
- Modify: `.github/workflows/ci.yml` (add an `onchain` job: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` in `onchain/`), `.gitignore` (`onchain/target/`, `.superpowers/`)

**Interfaces:**
- Produces:
  - `pub enum SignerKey { P256([u8; 33]), Ed25519([u8; 32]) }`, borsh- and serde-serializable; P-256 is compressed SEC1.
  - `pub struct Assertion { authenticator_data: Vec<u8>, client_data_json: String, signature: Vec<u8> }`. The signature is raw 64-byte `r‖s` for P-256 and 64 bytes for Ed25519.
  - `pub fn verify_assertion(key: &SignerKey, a: &Assertion, expected_challenge: &[u8; 32], rp_id_hash: &[u8; 32], allowed_origins: &[String]) -> Result<(), WebauthnError>`.

- [ ] **Step 1: Scaffold the workspace.** Pin the `near-sdk` 5.x minor and the `near/intents` git `rev` (record both in `Cargo.toml`, with a comment naming the upstream crate path). `build.sh` runs `cargo near build reproducible-wasm` in Docker for each crate and writes `onchain/target/near/<crate>/<crate>.wasm`. The `merchant-account` crate gets a `testnet-admin` cargo feature, off by default.

- [ ] **Step 2: Write failing tests** in `webauthn.rs` (`#[cfg(test)]`). They build assertions with the `p256` and `ed25519-dalek` crates (dev-deps) over synthetic `authenticatorData` and `clientDataJSON`:

  - `accepts_valid_p256_assertion` and `accepts_valid_ed25519_assertion`
  - `rejects_wrong_challenge`: clientData challenge ≠ base64url(expected)
  - `rejects_wrong_rp_id_hash`
  - `rejects_origin_not_allowed`
  - `rejects_type_not_webauthn_get`
  - `rejects_missing_user_present_or_verified_flag`: UP (0x01) and UV (0x04) are both required
  - `rejects_high_s_p256`: same `r`, `s' = n − s`
  - `rejects_signature_by_other_key`

- [ ] **Step 3: Run** `cd onchain && cargo test -p merchant-account webauthn`. Expected: FAIL to compile (functions are missing).

- [ ] **Step 4: Implement `verify_assertion`.** Reuse the `near/intents` WebAuthn crate for clientData parsing and the curve checks, where its API fits. If it doesn't, vendor the needed file with its license header and a source-commit comment. The signed message is `authenticator_data ‖ sha256(client_data_json)`. In contract builds, verification goes through `env::p256_verify` / `env::ed25519_verify`; unit tests use the same crates natively behind `#[cfg(not(target_arch = "wasm32"))]`.

- [ ] **Step 5: Run** the tests. Expected: PASS. Also run `cargo clippy --all-targets -- -D warnings` and get it clean.

- [ ] **Step 6: Commit** `feat(onchain): workspace and WebAuthn assertion verification`.

---

### Task 2: Threshold contract core: signers, proposals, epochs, events

**Files:**
- Create: `onchain/merchant-account/src/{action.rs,approval.rs,events.rs}`, `onchain/merchant-account/test-vectors/approval-payloads.json`
- Modify: `onchain/merchant-account/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 `SignerKey`, `Assertion`, `verify_assertion`.
- Produces (contract ABI; JSON args; `U128`/`U64` as strings; byte arrays as base64):
  - `new(config: InitConfig)`. `InitConfig { signers: Vec<Signer>, threshold: u8, recovery_key: Option<[u8;32]>, rp_id: String, origins: Vec<String>, intents_contract: AccountId, testnet_admin: Option<AccountId> }`, where `Signer { id: String, keys: Vec<SignerKey> }`. Here `id` is the API's `usr_…` id. `testnet_admin` is accepted only when built with `testnet-admin`.
  - `propose(action: Action, salt: Base64 [u8;32], approval: SignedApproval) -> ProposalId`, which creates the proposal and records the first approval.
  - `approve(proposal_id: ProposalId, approval: SignedApproval)`.
  - `execute(proposal_id: ProposalId)`. Anyone may call it; it runs only when ready (approvals and timelock).
  - `cancel(proposal_id: ProposalId, approval: SignedApproval)`. Any one current signer may cancel.
  - Views: `get_config() -> ConfigView` (signers, threshold, epoch, origins, rp_id, recovery_key_set) and `get_proposal(id) -> Option<ProposalView>`, `list_proposals(from_index: u32, limit: u32) -> Vec<ProposalView>`.
  - `SignedApproval { signer_id: String, key: SignerKey, assertion: Assertion }`.
  - `ProposalId = [u8; 32]` = `sha256(borsh(action) ‖ salt)`, shown as hex in JSON.
  - **The approval payload hash (what the passkey signs as its challenge):** `sha256(borsh(ApprovalPayload { domain: "tendr-merchant-account-v1", contract_id: String, proposal_id: [u8;32], signer_epoch: u64, intent: ApprovalIntent }))`, where `ApprovalIntent` is `Approve | Cancel`.
  - `Action` enum (borsh variant order is fixed as listed; tasks 3–5 fill in execution):
    - `AddSigner(Signer)`, `RemoveSigner { id }`, `AddSignerKey { id, key }`, `RemoveSignerKey { id, key }`
    - `SetThreshold(u8)`, `SetOrigins(Vec<String>)`, `RotateRecoveryKey(Option<[u8;32]>)`
    - `AddSavedAddress { id: String, chain: String, address: String }`, `RemoveSavedAddress { id }`
    - `SetLimits { asset: String, per_tx: Option<U128>, per_day: Option<U128> }`, `SetRefundCap { asset: String, daily: U128 }`
    - `SetAutoSweep { asset: String, trigger_above: U128, keep: U128, saved_address_id: String }`, `ClearAutoSweep { asset }`
    - `Withdraw { asset: String, amount: U128, saved_address_id: String, route: WithdrawRoute }`
    - `Refund { asset: String, amount: U128, destination_chain: String, destination: String, payment_id: String, route: WithdrawRoute }`
    - `Upgrade { code_hash: [u8;32] }`
    - `SetSettlement { dest_asset: String, payout_mode: PayoutMode /* Intents | Wallet */, saved_address_id: Option<String> }`, the last variant. On chain it only records the choice and emits `settlement_changed`; it exists so the change needs the threshold and leaves an on-chain record (spec §5).
  - `WithdrawRoute = Poa { token_contract: AccountId } | Swap { deposit_account: AccountId }`.
  - Events: NEP-297 `EVENT_JSON` with standard `tendr-merchant-account`, version `1.0.0`, and events `proposal_created`, `proposal_approved`, `proposal_cancelled`, `proposal_executed`, `proposal_failed`, `timelock_started`, `signers_changed`, `recovery_started`, `recovery_cancelled`, `recovery_executed`, `sweep_executed`, `settlement_changed`. Each carries `proposal_id` and decoded action fields where relevant.

- [ ] **Step 1: Write failing unit tests** (`near-sdk` `testing_env!`, assertions built with Task 1's test helpers):
  - `n_minus_one_approvals_never_execute`: threshold 2 of 3, one approval → status `Pending`, no state change.
  - `same_signer_two_devices_counts_once`: a signer with two keys approves with both → still 1.
  - `approval_bound_to_contract_id`: a payload hashed for `a.tendr.testnet`, submitted to `b.tendr.testnet` → rejected (Review Focus 1).
  - `approval_from_unknown_key_rejected`, `replayed_cancel_intent_cannot_approve`.
  - `threshold_above_signer_count_rejected`, both at init and via `SetThreshold`.
  - `signer_change_bumps_epoch_and_voids_pending_approvals`: a proposal has 1 of 2 approvals; `RemoveSigner` executes, epoch +1; the old approval no longer counts and re-approval needs the new epoch (Review Focus 2).
  - `removed_signer_cannot_approve`.
  - `expired_proposal_cannot_execute`: `PROPOSAL_TTL` passes, then `execute` → `Expired`.
  - `any_signer_can_cancel_pending`.
  - `init_rejects_testnet_admin_without_feature`.
  - `write_test_vectors`: writes `test-vectors/approval-payloads.json` with fixed inputs (contract id, 3 actions covering `Withdraw`, `AddSigner`, `Refund`, salt, epoch, both intents) and asserts the file matches what is committed. Regenerate it with `UPDATE_VECTORS=1`.

- [ ] **Step 2: Run** `cargo test -p merchant-account`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - State: signers, threshold, epoch, origins, rp_id_hash, recovery key, intents contract, `proposals: IterableMap<ProposalId, Proposal>`, where a `Proposal` holds the action, created_at, the approvals set keyed by signer id with the epoch they approved under, `ready_at: Option<u64>` and status.
  - On reaching threshold at the current epoch: run `execute_now` unless the action needs a timelock (Task 4), in which case set `ready_at` and emit `timelock_started`.
  - Security actions (`AddSigner`, `RemoveSigner`, `AddSignerKey`, `RemoveSignerKey`, `SetThreshold`, `SetOrigins`, `RotateRecoveryKey`) execute immediately and bump the epoch. The exceptions are `SetOrigins` and the key-only changes, which don't bump it.
  - Any action other than security, saved-address, limit and sweep actions panics with `"not yet supported"` until Tasks 3–5.

- [ ] **Step 4: Run** the tests. Expected: PASS. Commit the vectors file.

- [ ] **Step 5: Commit** `feat(onchain): threshold proposals, signer epochs and events`.

---

### Task 3: Saved addresses

**Files:**
- Create: `onchain/merchant-account/src/saved.rs`
- Modify: `onchain/merchant-account/src/lib.rs`

**Interfaces:**
- Produces:
  - view `list_saved_addresses() -> Vec<SavedAddressView { id, chain, address, active_from: U64 }>`;
  - internal `fn saved_address_usable(&self, id: &str, now: u64) -> Option<&SavedAddress>`, which Task 4 uses.

- [ ] **Step 1: Write failing tests:**
  - `saved_address_unusable_for_24h`: add at t; `saved_address_usable` is `None` at t + 24h − 1 ns and `Some` at t + 24h.
  - `remove_saved_address_is_immediate`.
  - `duplicate_saved_address_id_rejected`.
  - `settlement_wallet_mode_requires_usable_saved_address` (and `intents` mode needs none).
  - `chain_and_address_validated`: non-empty, max 128 chars, chain in `{near, eth, base, arbitrum, polygon, bsc, optimism, avalanche, sol, tron, btc}`. *(Ruling: start with this list and extend it by upgrade.)*

- [ ] **Step 2: Run** the tests and expect FAIL. **Implement** `AddSavedAddress`, `RemoveSavedAddress` and `SetSettlement` execution, storing `active_from = now + SAVED_ADDRESS_DELAY`. **Run** them again and expect PASS.

- [ ] **Step 3: Commit** `feat(onchain): saved addresses with 24h activation`.

---

### Task 4: Money movements, limits, refund cap, auto-sweep, and the mock verifier

**Files:**
- Create: `onchain/merchant-account/src/money.rs`, `onchain/mock-intents/{Cargo.toml,src/lib.rs}`
- Modify: `onchain/merchant-account/src/lib.rs`, `onchain/Cargo.toml`

**Interfaces:**
- Consumes: Task 3 `saved_address_usable`, Task 2 proposal lifecycle.
- Produces:
  - **The contract's outgoing calls to the intents contract,** each with 1 yocto attached:
    - `ft_withdraw { token, receiver_id: token_contract, amount, memo: "WITHDRAW_TO:<address>" }` for `Poa` routes on `nep141:` assets;
    - `mt_transfer { receiver_id: deposit_account, token_id: asset, amount }` for `Swap` routes.
  - New method `trigger_sweep(asset: String)`, callable by anyone.
  - Views: `get_limits(asset) -> LimitsView { per_tx, per_day, refund_cap, pending_raise: Option<(LimitsView, ready_at)>, spent_24h, refunded_24h }` and `get_auto_sweep(asset)`.
  - **Mock verifier** (`mock-intents`): `mt_transfer`, `ft_withdraw` and `mt_withdraw` record `(predecessor, attached_deposit, args)` into `calls` and move balances. Also `mt_batch_balance_of(account_id, token_ids)`, `get_calls() -> Vec<CallRecord>`, and test-only `deposit(account_id, token_id, amount)`, which the simulated provider uses in project 3.

- [ ] **Step 1: Write failing tests:**
  - `withdraw_requires_usable_saved_address`.
  - `withdraw_rechecks_saved_address_at_execute`: the address is removed between approval and execution of a timelocked swap → `proposal_failed` (Review Focus 4).
  - `per_tx_and_per_day_limits_enforced`: the per-day limit is a rolling 24h sum of executed withdrawals.
  - `lowering_limit_immediate_raising_waits_24h`.
  - `limit_lowered_while_timelocked_withdrawal_pending_fails_at_execute` (Review Focus 4).
  - `swap_withdrawal_timelocked_24h_and_cancellable`.
  - `refund_under_cap_executes_immediately`.
  - `refunds_summing_over_cap_timelock_the_crossing_one`: cap 100; refunds of 60 then 50 → the second gets `timelock_started` (Review Focus 3).
  - `refund_cap_window_is_rolling_24h`.
  - `sweep_only_to_saved_address_and_only_above_trigger`: `trigger_sweep` by an arbitrary account sends `balance − keep` when `balance > trigger_above`, and does nothing otherwise.
  - `outgoing_call_attaches_one_yocto_and_uses_route_args`. This is a unit test on the built `Promise`; the sandbox test in Task 6 proves it end to end.

- [ ] **Step 2: Run** the tests and expect FAIL.

- [ ] **Step 3: Implement.**
  - Timelock rule: `Withdraw` with `Swap`, `Refund` whose amount pushes `refunded_24h` over `refund_cap`, and `SetLimits` that raises any value all get `ready_at = now + TIMELOCK_DELAY`. Everything else executes on the threshold. *(Amended by R34, final review: `AddSigner`, `AddSignerKey`, `RotateRecoveryKey` (including clearing it), `SetThreshold` that lowers the threshold, and `SetOrigins` are also timelocked 24 h, cancellable by any signer, re-validated at execute and announced by `timelock_started`. Removals and threshold raises stay instant. See the spec's Amendments section.)*
  - Execution re-validates limits, saved addresses and the cap at execute time.
  - The rolling windows keep per-asset `(timestamp, amount)` entries pruned to 24 h. *(Ruling: no fixed day buckets.)*
  - The balance for a sweep is read with a cross-contract `mt_batch_balance_of` call, and the callback sends the transfer.
  - Failed outgoing calls mark the proposal `Failed` in a callback, and the windows are not charged.

- [ ] **Step 4: Run** the tests and expect PASS.

- [ ] **Step 5: Commit** `feat(onchain): withdrawals, refunds, limits, sweep, mock verifier`.

---

### Task 5: Recovery, upgrade, testnet admin

**Files:**
- Create: `onchain/merchant-account/src/recovery.rs`
- Modify: `onchain/merchant-account/src/lib.rs`

**Interfaces:**
- Produces:
  - `start_recovery(new_signers: Vec<Signer>, new_threshold: u8, nonce: U64, signature: Base64)`. The recovery key's Ed25519 signature covers `sha256(borsh(RecoveryPayload { domain: "tendr-merchant-account-recovery-v1", contract_id, new_signers, new_threshold, nonce }))`, and `nonce` must exceed the last used nonce.
  - `cancel_recovery(approval: SignedApproval)`, by any current signer (intent `Cancel`, `proposal_id = [0;32]`).
  - `execute_recovery()`, callable by anyone after 72 h.
  - View `get_recovery() -> Option<RecoveryView { new_signer_ids, new_threshold, executes_at }>`.
  - `Upgrade` action execution (deploy from global code hash, then migrate).
  - `admin_sync_signers(signers, threshold)`, compiled only under `testnet-admin` and callable only by `testnet_admin`.

- [ ] **Step 1: Write failing tests:**
  - `recovery_key_cannot_propose_or_approve_money`: a recovery-key signature used as `SignedApproval` → rejected.
  - `recovery_executes_only_after_72h`.
  - `any_signer_cancels_recovery`.
  - `recovery_replaces_signers_bumps_epoch_and_voids_pending` (Review Focus 2).
  - `recovery_nonce_replay_rejected`.
  - `recovery_rejects_threshold_above_new_signer_count`.
  - `upgrade_requires_threshold`.
  - `admin_sync_absent_without_feature`: compile-time; the default build exposes no `admin_sync_signers`, checked by the ABI listing in Task 6.
  - `admin_sync_only_by_admin` (feature on).

- [ ] **Step 2: Run** the tests and expect FAIL. **Implement**, then **run** them again and expect PASS.

- [ ] **Step 3: Commit** `feat(onchain): 72h recovery, upgrades, testnet admin feature`.

---

### Task 6: Sandbox integration tests

**Files:**
- Create: `onchain/merchant-account/tests/sandbox.rs`
- Modify: `.github/workflows/ci.yml` (the `onchain` job builds the wasm via `scripts/build.sh` and runs `cargo test --test sandbox`)

**Interfaces:**
- Consumes: wasm builds of both crates.

- [ ] **Step 1: Write the sandbox tests.**
  - Setup: `near-workspaces` deploys `mock-intents`, publishes `merchant-account` as a global contract, then creates `shop.test.near` in one batch from a parent account: `CreateAccount + Transfer + UseGlobalContract + FunctionCall new`, with **no AddKey**. Then:
  - `account_has_no_access_keys`: `view_access_keys(shop)` is empty.
  - `withdraw_end_to_end`: deposit into the mock, add a saved address, fast-forward 24h, run 2-of-2 approvals from a third "relayer" account → the mock records `ft_withdraw` with predecessor `shop`, 1 yocto, and the expected memo.
  - `relayer_cannot_alter_action`: the relayer submits `approve` with a different `proposal_id` or mutated args → rejected.
  - `default_build_has_no_admin_method`: calling `admin_sync_signers` fails with a method-not-found error.
  - `upgrade_via_proposal_switches_code_hash`.

- [ ] **Step 2: Run** `onchain/scripts/build.sh && cd onchain && cargo test --test sandbox`. Expected: PASS. (If Docker is unavailable on the dev machine, the job must still pass in CI. Report this rather than skipping it.)

- [ ] **Step 3: Commit** `test(onchain): sandbox integration with mock intents verifier`.

---

### Task 7: Schema, contracts package, relayer key

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/lib/ids.ts`, `apps/api/src/db/models.ts`, `apps/api/src/keyvault/{types,keys}.ts`, `packages/contracts/src/{index,enums}.ts`
- Create: migration `apps/api/prisma/migrations/<ts>_merchant_accounts/`, `packages/contracts/src/accounts.ts` (+ test)

**Interfaces:**
- **New tables** (spec §8; all ids prefixed):

  | Table | Id prefix | Columns |
  |---|---|---|
  | `users` | `per` | email unique (lower-cased), email_verified_at |
  | `webauthn_credentials` | `cred` | user_id, credential_id unique, public_key (`SignerKey` JSON), sign_count, transports[], device_label, last_used_at |
  | `dashboard_sessions` | `dss` | user_id, token_hash unique, expires_at, revoked_at |
  | `email_tokens` | `etok` | email, purpose (`verify`, `login`, `invite`), token_hash unique, expires_at, consumed_at |
  | `merchant_invites` | `inv` | merchant_id, email, role, make_signer, token_hash, expires_at, accepted_at |
  | `merchant_accounts` | `macc` | merchant_id, livemode, near_account_id unique, contract_code_hash, threshold, signer_epoch, status (`provisioning`, `active`, `failed`), created_tx; unique (merchant_id, livemode) |
  | `account_proposals` | `prop` | merchant_id, livemode, account_id, onchain_id (hex, unique per account), kind, action (json), salt, status (`draft`, `pending`, `timelocked`, `executed`, `cancelled`, `expired`, `failed`), created_by_user_id, ready_at, executed_at, last_tx_hash |
  | `account_approvals` | `appr` | proposal_id, user_id, credential_id, signer_epoch, tx_hash |
  | `recovery_requests` | `rec` | merchant_id, livemode, executes_at, status, new_signer_ids[], tx hashes |

  - `dashboard_sessions` has 30-day sliding expiry. *(Ruling: lifetime is the builder's choice; 30 days is the default here.)*
  - `merchant_accounts` replaces the idea of `merchants.near_account_id`.
  - The proposal kinds are the `Action` variant names in snake_case.
  - Not tenant-scoped (no merchant): `users`, `webauthn_credentials`, `dashboard_sessions`, `email_tokens`.
  - Per-mode: `merchant_accounts`, `account_proposals`, `account_approvals`, `recovery_requests`.
- **Changed tables:**
  - `merchant_users`: add `user_id` (FK `users`), `is_signer` (default false). Drop `email`, `auth_provider` and `mfa_enabled`. Make it unique on `(merchant_id, user_id)`.
  - `account_keys`: add `user_id` (nullable), `livemode`, `credential_id` (nullable). Add enum value `recovery`.
- `packages/contracts/src/accounts.ts`:
  - `MerchantPermission = 'account:read' | 'money:request' | 'team:manage' | 'settings:manage' | 'security:propose' | 'webhooks:resend'`.
  - `ROLE_PERMISSIONS: Record<MerchantUserRole, readonly MerchantPermission[]>`, following the spec §2 table:

    | Role | Permissions |
    |---|---|
    | viewer | `account:read` |
    | finance | + `money:request` |
    | admin | + `team:manage`, `settings:manage`, `webhooks:resend` |
    | owner | + `security:propose` |

  - `ProposalKindValues`, `ProposalStatusValues`, and `isSecurityKind(kind)`.
- `KeyName` gains `'relayer-accounts'` (ed25519). Its registry comment: gas-only relayer for merchant account contracts.

- [ ] **Step 1: Write failing tests:**
  - `accounts.test.ts`: a viewer lacks `money:request`, finance has it, only owner has `security:propose`, and every role has `account:read`.
  - Extend `schema.test.ts`: the new per-mode tables are in the scoped model list, with test/live isolation as for existing tables; `merchant_users` unique `(merchant_id, user_id)`; an `account_approvals` row cannot reference another merchant's proposal (composite FK).
  - Extend the keyvault test: `relayer-accounts` signs and verifies as Ed25519.

- [ ] **Step 2: Run** `npm test --workspace=@tendr/contracts && npm test --workspace=@tendr/api`. Expected: FAIL.

- [ ] **Step 3: Implement** the schema and migration with `prisma migrate dev --name merchant_accounts`, adding composite FKs by hand-written SQL in the migration as the foundation did. Then the id prefixes, model lists, key registry and the contracts module. Update `prisma/seed.ts` so the seeded owner becomes a `users` row plus a membership, and adjust `seed.test.ts`.

- [ ] **Step 4: Run** the tests and expect PASS. Run `npm run typecheck` and expect it clean.

- [ ] **Step 5: Commit** `feat(api): schema for people, passkeys, merchant accounts and proposals`.

---

### Task 8: NEAR client and account provisioning

**Files:**
- Create: `apps/api/src/near/{rpc.ts,tx.ts,client.ts,fake.ts,provision.ts}` (+ tests)
- Modify: `apps/api/src/env.ts`, `turbo.json` (`globalPassThroughEnv`: add every new env var), `.env.example`

**Interfaces:**
- Consumes: `KeyVault.sign('funding-near' | 'relayer-accounts', bytes)`, `publicKey`.
- Produces:
  - `interface NearClient { call(signer: 'relayer-accounts', contractId: string, method: string, args: object, opts?: { gas?: bigint; deposit?: bigint }): Promise<TxResult>; view<T>(contractId: string, method: string, args: object): Promise<T>; provisionAccount(p: ProvisionParams): Promise<TxResult>; accessKeys(accountId: string): Promise<string[]> }`.
  - `TxResult { txHash: string; logs: string[]; status: 'success' | 'failure'; failure?: string }`.
  - `ProvisionParams { livemode: boolean; accountId: string; init: InitConfigJson; initialBalanceYocto: bigint }`.
  - `nearClient(livemode: boolean): NearClient`, selected by env.
  - `class FakeNearClient implements NearClient`, in-memory, for API tests. It records calls, returns scripted logs and tracks provisioned accounts.
- New env vars: `NEAR_RPC_URL_LIVE`, `NEAR_RPC_URL_TEST`, the four parent/intents ids from Global Constraints, `MERCHANT_ACCOUNT_CODE_HASH_LIVE` and `MERCHANT_ACCOUNT_CODE_HASH_TEST`, `NEAR_CLIENT_DRIVER` (`rpc` | `fake`, default `fake` in test), `FUNDING_DAILY_CAP_YOCTO`, `FUNDING_PER_ACCOUNT_YOCTO`.

- [ ] **Step 1: Write failing tests:**
  - `provision_builds_create_transfer_useglobal_init_and_no_addkey`: decode the signed tx and assert the actions are exactly `[CreateAccount, Transfer(initialBalance), UseGlobalContract(codeHash), FunctionCall('new', init)]`, signed by `funding-near` for the parent account.
  - `provision_refuses_above_per_account_cap`, and `provision_refuses_when_daily_cap_exhausted`, counting from a `funding_spend` ledger. *(Ruling: record each provisioning spend as an `events` row `funding.spent`; the daily total is summed from events of the last 24h.)*
  - `tx_signature_verifies_against_kv_public_key`.
  - `fake_client_records_calls`.

- [ ] **Step 2: Run** the tests and expect FAIL.

- [ ] **Step 3: Implement** using `@near-js/transactions` + `@near-js/providers`. The signature is `kv.sign('funding-near', sha256(borsh(tx)))`. If the installed `@near-js/transactions` lacks a `UseGlobalContract` action (NEP-591), add a local borsh schema extension in `tx.ts` with a comment citing the NEP. Nonce and block hash come from RPC `view_access_key` / `block`.

- [ ] **Step 4: Run** the tests and expect PASS.

- [ ] **Step 5: Commit** `feat(api): NEAR client, KMS-signed transactions, capped provisioning`.

---

### Task 9: People, passkeys, sessions, signup, team, invites

**Files:**
- Create: `apps/api/src/auth/{webauthn.ts,session.ts,magic-link.ts,mailer.ts}`, `apps/api/src/merchants/{signup.ts,team.ts,invites.ts}`, `apps/api/src/routes/{auth.ts,merchants.ts,team.ts}` (+ tests)
- Modify: `apps/api/src/gateway/{principal.ts,auth.ts}`, `packages/contracts/src/auth.ts`, `apps/api/src/env.ts`

**Interfaces:**
- **Principals.** New `user_session` principal `{ kind: 'user_session'; userId: string }`, carrying no merchant and no db. `dashboard_user` gains `membershipId`, `isSigner` and `permissions: MerchantPermission[]`.
- **Resolution.** The `tendr_session` cookie (HttpOnly, Secure outside dev, SameSite=Lax) resolves the person. A `Tendr-Merchant: mer_…` header plus a `Tendr-Livemode: true|false` header resolve the membership → `dashboard_user`. A missing membership → 403.
- `RouteAuth` gains an optional `permission`, checked against the principal's permissions.
- **CSRF.** Cookie-authenticated mutating requests must send `Tendr-CSRF: <value of tendr_csrf cookie>`. *(Ruling: double-submit cookie.)*
- `Mailer { send(msg: { to: string; template: MailTemplate; data: Record<string, string> }): Promise<void> }`.
  - Drivers: `log` (dev: writes to the logger and to `apps/api/.mail/` as JSON), `memory` (tests). The production driver is the builder's choice, through env `MAIL_DRIVER`.
  - `MailTemplate` values: `verify_email`, `login_link`, `invite`, `proposal_needs_approval`, `timelock_started`, `recovery_started`, `recovery_executes_soon`, `proposal_executed`.
- **WebAuthn.**
  - `registrationOptions(user)` / `verifyRegistration(user, response, deviceLabel)` → stores `webauthn_credentials` with `public_key` as a `SignerKey` (COSE → compressed P-256 or raw Ed25519). Algorithms are ES256 and EdDSA only, and user verification is `required`.
  - `authenticationOptions(email?)` / `verifyAuthentication(response) → userId`.
  - Env: `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME` (`Tendr`), `WEBAUTHN_ORIGINS` (comma list).
- **Routes:**
  - `POST /v1/auth/email/start` sends verification or a login link. `POST /v1/auth/email/verify` takes a token and returns a session.
  - `POST /v1/auth/passkeys/register/options|verify` and `POST /v1/auth/passkeys/login/options|verify`.
  - `POST /v1/auth/logout` and `GET /v1/me`, which returns the person and their stores.
  - `POST /v1/merchants` creates a store: name → slug, owner membership with `is_signer = true`. `GET /v1/merchants/:id`.
  - `GET /v1/team`; `POST /v1/team/invites` (`team:manage`); `POST /v1/invites/accept` (`user_session`); `PATCH /v1/team/:membershipId` for role changes (`team:manage`; owners only change owners).
  - Setting `is_signer` is not a PATCH: it is an `AddSigner` / `RemoveSigner` proposal (Task 10), mirrored on execution by Task 12.

- [ ] **Step 1: Write failing tests:**
  - `signup_creates_person_store_and_owner_signer_membership`.
  - `slug_collision_gets_suffix`: `acme`, `acme-2`. Slugs are lowercase `[a-z0-9-]`, 3–32 chars, and must be valid NEAR sub-account labels.
  - `concurrent_signup_same_email_creates_one_person`.
  - `magic_link_single_use_and_expires_15min`.
  - `passkey_register_requires_uv_and_stores_signer_key`: uses `@simplewebauthn/server` test fixtures or a generated software authenticator.
  - `login_assertion_cannot_be_used_as_approval`: the login challenge is random and server-issued, so it never equals a payload hash. Assert the challenge namespaces differ.
  - `dashboard_user_requires_membership_for_header_merchant`.
  - `livemode_header_isolates_rows`.
  - `csrf_required_on_cookie_mutations`.
  - `invite_existing_person_joins_without_new_user` (Review Focus 5).
  - `invite_accept_requires_matching_verified_email`.
  - `role_change_by_admin_cannot_touch_owner`.

- [ ] **Step 2: Run** the tests and expect FAIL.

- [ ] **Step 3: Implement** with `@simplewebauthn/server` 13. Session tokens are 32 random bytes; only `sha256(token)` is stored.

- [ ] **Step 4: Run** the tests and expect PASS. Then the full `npm test --workspace=@tendr/api`, also expecting PASS.

- [ ] **Step 5: Commit** `feat(api): passkey login, sessions, signup, team and invites`.

---

### Task 10: Approval encoding and the proposal service

**Files:**
- Create: `apps/api/src/accounts/{encoding.ts,proposals.ts}` (+ tests), `apps/api/src/routes/proposals.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: the Task 2 vectors file, `NearClient`, the Task 7 tables, and `requirePermission` (Task 9). 
- Produces:
  - `encodeAction(a: ActionJson): Uint8Array`, `proposalId(a, salt) → hex`, `approvalChallenge({ contractId, proposalId, signerEpoch, intent: 'approve' | 'cancel' }): Uint8Array`.
  - `normalizeP256Signature(der: Uint8Array): Uint8Array`: DER → raw `r‖s` with low-s. Authenticators may return high-s; the contract rejects it, so the relay flips `s = n − s`.
  - `createDraft(ctx, { kind, action }) → AccountProposal` with status `draft`. Any user with `money:request` (money kinds) or `security:propose` (security kinds) may create one.
  - `challengeFor(ctx, proposalId) → { challengeB64u, allowCredentials }`.
  - `submitApproval(ctx, proposalId, webauthnResponse) → AccountProposal`. The first signer's approval calls `propose`; later ones call `approve`. Only memberships with `is_signer` and a registered credential may submit.
  - `cancelProposal(ctx, proposalId, webauthnResponse)`.
  - `validateLocally(ctx, action) → void | AppError`, which mirrors the contract's saved-address, limit, threshold and chain checks for fast 4xx.
- Routes: `POST /v1/account/proposals` (draft), `GET /v1/account/proposals[?status]`, `GET /v1/account/proposals/:id`, `POST /v1/account/proposals/:id/challenge`, `POST /v1/account/proposals/:id/approve`, `POST /v1/account/proposals/:id/cancel`.

- [ ] **Step 1: Write failing tests:**
  - `encoding_matches_rust_vectors`: for every entry in `approval-payloads.json`, `encodeAction`, `proposalId` and `approvalChallenge` match byte for byte.
  - `normalize_flips_high_s`.
  - `non_signer_can_draft_but_not_approve`.
  - `viewer_cannot_draft`.
  - `first_approval_calls_propose_then_approve` (`FakeNearClient`).
  - `draft_stays_offchain_until_signer_approves`: no NEAR call on draft.
  - `local_validation_rejects_unsaved_address_withdraw`.
  - `approval_with_stale_epoch_rejected_before_relay`.
  - `settlement_change_is_a_proposal_not_a_patch`: there is no route that writes `settlement_configs` directly.

- [ ] **Step 2: Run** the tests and expect FAIL.

- [ ] **Step 3: Implement.** The borsh schema mirrors Task 2's `Action` exactly, in the same variant order. WebAuthn response parsing uses `@simplewebauthn/server` helpers to extract `authenticatorData`, `clientDataJSON` and the signature, and does not trust any client-sent fields beyond those.

- [ ] **Step 4: Run** the tests and expect PASS.

- [ ] **Step 5: Wire the routes**, with `auth: { principals: ['dashboard_user'], permission: … }` per route, and **commit** `feat(api): approval encoding and proposal relay`.

---

### Task 11: Provisioning, go-live, test mirror, balances

**Files:**
- Create: `apps/api/src/accounts/accounts.ts`, `apps/api/src/routes/accounts.ts` (+ tests)

**Interfaces:**
- Consumes: `NearClient.provisionAccount`, Task 10 encoding, Task 9 memberships and credentials.
- Produces:
  - **`provisionTestAccount(merchantId)`.** Runs right after the first passkey is registered on a new store. It creates `<slug>.tendr.testnet` with:
    - the signers being the store's current signer memberships, each with all their credentials;
    - threshold 1;
    - `testnet_admin` = the test parent account;
    - origins from `WEBAUTHN_ORIGINS`;
    - `rp_id` = `WEBAUTHN_RP_ID`.
  - **`registerRecoveryKey(merchantId, publicKeyB64)`.** Stores an `account_keys` row of kind `recovery`. Before go-live it is part of the init config; after go-live, it is set on chain by a `RotateRecoveryKey` proposal.
  - **`goLiveCheck(merchantId) → { ok: boolean; missing: ('second_key' | 'threshold')[] }`.** The rule is `signerCount + (recoveryKey ? 1 : 0) >= 2` and `threshold <= signerCount`.
  - **`goLive(merchantId)`.** Runs `goLiveCheck`, then provisions `<slug>.tendr.near` seeded with the current signers, the threshold chosen at go-live (default 1, owner may pick ≤ signers) and the recovery key, with no admin. Creates the live `merchant_accounts` row.
  - **`mirrorTestSigners(merchantId)`.** After any executed live signer or threshold change, calls `admin_sync_signers` on the test contract via the test parent key. *(Ruling: the test parent account is also the `testnet_admin`; it is a `LocalKeyVault`/KMS key named `funding-near` on testnet.)*
  - **`getBalances(merchantId, livemode)`.** Calls `mt_batch_balance_of` on the mode's intents contract for the assets in `settlement_configs` plus any held assets. Cached for 15 s in Redis.
- Routes: `POST /v1/account/recovery-key` (`security:propose`), `GET /v1/account/go-live` (check), `POST /v1/account/go-live` (owner), `GET /v1/account` (account ids, status, threshold, epoch, signers), `GET /v1/account/balances`.

- [ ] **Step 1: Write failing tests** (`FakeNearClient`):
  - `test_account_provisioned_after_first_passkey`.
  - `go_live_blocked_with_one_key` / `go_live_allowed_with_passkey_plus_recovery` / `go_live_allowed_with_two_signers`.
  - `go_live_rejects_threshold_above_signers`.
  - `live_account_has_no_testnet_admin`: assert on the init args.
  - `test_principal_cannot_read_live_account`.
  - `balances_cached_15s`.
  - `provisioning_failure_marks_account_failed_and_is_retryable`.

- [ ] **Step 2: Run** the tests and expect FAIL. **Implement**, then **run** them again and expect PASS.

- [ ] **Step 3: Commit** `feat(api): account provisioning, go-live rule, test mirror, balances`.

---

### Task 12: Chain reconciliation, mirror updates, notices, recovery API

**Files:**
- Create: `apps/api/src/accounts/watcher.ts`, `apps/api/src/jobs/account-notices.ts`, `apps/api/src/routes/recovery.ts` (+ tests)
- Modify: `apps/api/src/jobs/register-handlers.ts`, `apps/api/src/worker.ts`

**Interfaces:**
- Consumes: `NearClient.view`, `TxResult.logs`, `Mailer`, `recordEvent`.
- Produces:
  - **`parseAccountEvents(logs: string[]) → AccountEvent[]`.** Parses the NEP-297 `tendr-merchant-account` events.
  - **`applyAccountEvents(ctx, accountId, events)`.** Idempotent. Updates `account_proposals` status, `ready_at` and `executed_at`. On `settlement_changed` it writes the `settlement_configs` mirror, which project 3 reads. On signer or threshold changes it updates the `merchant_users.is_signer`, `account_keys` and `merchant_accounts.threshold/signer_epoch` mirrors. It writes `events` rows typed `account.proposal.created|approved|timelocked|executed|failed|cancelled`, `account.signers.changed` and `account.recovery.started|cancelled|executed`.
  - **`reconcileAccount(merchantId, livemode)`.** A scheduled worker job, every 60 s per active account. It reads `get_config`, `list_proposals` and `get_recovery`, and applies any difference. This catches transactions not sent by our relayer, so notices never depend on the website or the API. *(Ruling: there is no indexer for the pilot; the relayer applies its own tx logs immediately, and reconciliation is the backstop.)*
  - **`executeReadyTimelocks`.** A scheduled job that calls `execute` for `timelocked` proposals past `ready_at`. It is permissionless, so the relayer can do it.
  - **`executeReadyRecovery`.** The same for recoveries.
  - **Notices** go out through outbox handlers to every signer of the store:
    - `account.proposal.created` → `proposal_needs_approval`;
    - `account.proposal.timelocked` → `timelock_started`, carrying the decoded destination, amount, asset, `ready_at`, and a cancel link;
    - `account.recovery.started` → `recovery_started`, plus a delayed job at `executes_at − 24h` → `recovery_executes_soon`;
    - `account.proposal.executed` → `proposal_executed`.

    The email content is built from the on-chain action decoded by the worker, never from the draft the website sent.
  - **Recovery routes:**
    - `POST /v1/account/recovery/start` (`user_session`, plus a merchant id in the body): the body carries `{ newSigners, newThreshold, nonce, signature }`, signed client-side by the recovery kit, and is relayed.
    - `POST /v1/account/recovery/cancel` (signer WebAuthn).
    - `GET /v1/account/recovery`.

- [ ] **Step 1: Write failing tests:**
  - `parse_ignores_foreign_standard_logs`.
  - `apply_is_idempotent_on_replay`.
  - `signer_removed_onchain_updates_mirror`.
  - `reconcile_catches_proposal_created_outside_relayer`.
  - `timelock_notice_uses_onchain_action_not_draft`: the draft in the DB says destination A, the chain says B → the email says B.
  - `recovery_soon_notice_scheduled_24h_before`.
  - `ready_timelock_executed_by_job`.
  - `recovery_start_relays_signed_payload_unchanged`.

- [ ] **Step 2: Run** the tests and expect FAIL. **Implement**, then **run** them again and expect PASS.

- [ ] **Step 3: Commit** `feat(api): chain reconciliation, signer notices and recovery API`.

---

### Task 13: Web: signup, login, passkeys, recovery kit, account home

**Files:**
- Create: `apps/web/src/lib/{api.ts,webauthn.ts,recovery-kit.ts}` (+ vitest tests), `apps/web/src/app/(auth)/signup/page.tsx`, `(auth)/login/page.tsx`, `(auth)/verify/page.tsx`, `(auth)/invite/[token]/page.tsx`, `apps/web/src/app/dashboard/{layout.tsx,page.tsx,onboarding/store/page.tsx,onboarding/second-key/page.tsx}`
- Modify: `apps/web/package.json` (`@simplewebauthn/browser`, `@noble/curves`, `@noble/hashes`, `borsh`, `qrcode`), `apps/web/next.config.ts` (security headers)

**Interfaces:**
- Consumes: Task 9 and 11 routes. The approval challenge comes from the server (Task 10).
- Produces:
  - `api<T>(path, init?)`: fetch to `NEXT_PUBLIC_API_BASE_URL` with credentials, the `Tendr-CSRF`, `Tendr-Merchant` and `Tendr-Livemode` headers, and typed errors.
  - `registerPasskey()`, `loginWithPasskey()` and `signChallenge(challengeB64u, allowCredentials) → AuthenticationResponseJSON`.
  - `createRecoveryKit() → { secretWords: string; publicKeyB64: string }`. It is an Ed25519 key from 32 random bytes. The kit text is base32 of the secret in groups of 4, plus a checksum. *(Ruling: no BIP39 dependency.)*
  - `recoveryKitPdfOrPrint(kit)`: a print-friendly page with the QR code.
  - `signRecovery(kitSecret, payloadBytes) → signatureB64`.
  - The secret never leaves the browser and is not stored in local storage.
- Screens (spec §9, items 1–4):
  1. **Signup:** email, then the link, then the passkey.
  2. **Store name:** shows the slug and `<slug>.tendr.testnet`.
  3. **Second key:** add a device (QR to the login-and-add page), invite a signer, or create the recovery kit. Kit creation requires typing back characters 5–8 of the secret before it is registered.
  4. **Account home:** test and live balances, account ids, and a "Go live" checklist from `GET /v1/account/go-live`.
- Mode switch (test/live) and store switch sit in the dashboard header.
- **Headers:**
  - On signing pages (`/dashboard/approvals/*`, `/dashboard/recovery/*`, `/dashboard/onboarding/*`): CSP `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self' <API origin>`.
  - On all dashboard routes: `X-Frame-Options: DENY`.
  - No third-party scripts anywhere under `/dashboard`.

- [ ] **Step 1: Write failing vitest tests:**
  - `recovery_kit_roundtrip`: the secret → public key matches, and the checksum rejects a typo.
  - `signRecovery_verifies_with_noble`.
  - `api_sends_csrf_and_merchant_headers`.

- [ ] **Step 2: Run** `npm test --workspace=@tendr/web` and expect FAIL. **Implement** the libraries, then the screens. **Run** the tests again and expect PASS. Run `npm run typecheck --workspace=@tendr/web` and expect it clean.

- [ ] **Step 3: Commit** `feat(web): signup, passkeys, recovery kit and account home`.

---

### Task 14: Web: team, approvals, withdraw, saved addresses, security, recovery, and e2e

**Files:**
- Create: `apps/web/src/app/dashboard/{team,approvals,approvals/[id],withdraw,addresses,security,recovery}/page.tsx`, `apps/web/e2e/merchant-accounts.spec.ts`
- Modify: `apps/web/playwright.config.ts` (start api + web against the test DB, with `NEAR_CLIENT_DRIVER=fake` and `MAIL_DRIVER=log`)

**Interfaces:**
- Consumes: the Task 10–12 routes and Task 13's libraries.
- Screens (spec §9, items 5–10):
  - **Team.** Invite, role select, and "Make signer", which creates an `AddSigner` draft.
  - **Approvals inbox.** Pending, timelocked (with countdown and cancel) and history.
  - **Proposal detail.** Shows the human summary decoded from the action returned by `GET /v1/account/proposals/:id`, then Approve runs `signChallenge` and posts the result. The summary always shows the full destination address and the chain, never a nickname alone.
  - **Withdraw.** Saved address, asset, amount, and receive token/chain. If the receive token differs, the route is `Swap`, with a notice that it waits 24 h.
  - **Saved addresses.** Add (with a notice that it waits 24 h) and remove.
  - **Security.** Threshold, per-asset limits, refund cap, auto-sweep, and recovery kit status/rotate.
  - **Recovery.** Start (paste or scan the kit, choose the new signers from the team, then sign) and cancel, plus a global banner while a recovery is pending.

- [ ] **Step 1: Write the Playwright test** `merchant-accounts.spec.ts`, using a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2, internal, hasUserVerification, isUserVerified):

  1. Sign up and read the email link from the API's `.mail/` folder.
  2. Register a passkey, name the store, create and confirm the recovery kit, and land on account home with `go-live ok`.
  3. Add a saved address. Fast-forward is not possible here, so assert it shows "usable in 24h".
  4. A finance invitee is invited and accepted in a second browser context. They draft a withdrawal to the saved address, which the API rejects as not yet usable. *(The `FakeNearClient` can't move time; assert the 4xx message instead.)*
  5. The owner approves an `AddSavedAddress` draft created by the finance user. After the owner's approval it shows `pending` → `executed` (threshold 1, fake client).

- [ ] **Step 2: Run** `npm run test:e2e --workspace=@tendr/web` and expect PASS.

- [ ] **Step 3: Commit** `feat(web): team, approvals, money-out, security and recovery screens`.

---

### Task 15: Publish and verify scripts, docs, foundation amendment

**Files:**
- Create: `apps/api/scripts/onchain-publish-testnet.ts`, `apps/api/scripts/verify-merchant-account-mainnet.ts`
- Modify: `apps/api/package.json` (scripts `onchain:publish:testnet`, `onchain:verify:mainnet`), `README.md` (merchant accounts section: local dev with the fake client, testnet publish, mainnet checks), `docs/superpowers/specs/2026-10-23-foundation-design.md` (amendments: named key `relayer-accounts`; project order 2↔3; the JS widget moved to project 3), `infra/terraform/gcp` (add the `relayer-accounts` Ed25519 KMS key, written and validated, not applied)

**Interfaces:**
- **`onchain:publish:testnet`.** Builds via `onchain/scripts/build.sh`, publishes the `merchant-account` global contract built **with** `testnet-admin`, and deploys `mock-intents` to `intents-mock.tendr.testnet`. It prints the code hash to put in `MERCHANT_ACCOUNT_CODE_HASH_TEST`. It is run by the user, not CI.
- **`onchain:verify:mainnet`.** Manual, run by the user with a funded mainnet test account. It checks the spec's "Assumptions to verify early" 1–4 and 6, printing PASS/FAIL per step and stopping at the first FAIL:
  1. Deploy the default build to a throwaway sub-account and call a `p256_verify` probe view built into a debug feature. *(Ruling: add a `probe` cargo feature with a `probe_p256` view; this build is used only by the script.)*
  2. Request a 1Click quote with `recipientType INTENTS` to the throwaway contract for about $1, and a refund to it.
  3. Do a threshold-approved `ft_withdraw` with a `WITHDRAW_TO:` memo for USDC to an EVM address the user supplies.
  4. Create a sub-account with no `AddKey`.
  5. Check the storage deposit for the withdrawal token.
- Assumption 5, the testnet intents verifier, is answered by the publish script: it uses our mock, as the plan already rules.

- [ ] **Step 1: Write the scripts.** Both scripts must refuse to run without an explicit `--yes-i-understand-this-spends-mainnet-funds` flag (mainnet) or `--network testnet`. Unit-test their argument parsing and refusal paths in `scripts/*.test.ts`, which `tsconfig.scripts.json` already includes.
- [ ] **Step 2: Run** `npm test --workspace=@tendr/api` and expect PASS. Run `docker run --rm -v $PWD/infra/terraform/gcp:/w -w /w hashicorp/terraform:1.9.8 validate` (after `init -backend=false`) and expect "Success".
- [ ] **Step 3: Update the docs and the foundation amendment.**
- [ ] **Step 4: Commit** `chore: onchain publish and mainnet verify scripts, docs, foundation amendments`.

---

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| Threat scope (refund cap, swap timelock, out-of-band notices, CSP) | 4, 12, 13 |
| §1 On-chain architecture (zero keys, predecessor auth, passkeys in contract, proposals from signers, relayer key, global contract, upgrades, audit gate) | 1–6, 8, 15 (the audit gate is enforced by never setting a live code hash without the user; noted in README) |
| §2 Keys, roles, RP ID, recovery, two-key rule, AccountKey mirror, multi-store people | 5, 7, 10, 11, 12 |
| §3 Signup and onboarding | 10, 11, 13 |
| §4 Money out (flow, refunds, withdrawals, saved addresses, limits, auto-sweep) | 3, 4, 9, 12, 14 |
| §5 Settlement destination (setting is a proposal, `wallet` mode requires a saved address) | 2 (`SetSettlement` variant), 3 (on-chain check), 10 (proposal only), 12 (mirror) |
| §6 Test mode (test contract sandbox, mirror, one kit, mock verifier) | 4, 11, 15 |
| §7 Services and API | 8–12 |
| §8 Data model | 7 |
| §9 Screens | 13, 14 |
| Acceptance | 1–6 (contract), 6 + 15 (integration), 9–12 (API), 14 (Playwright) |
