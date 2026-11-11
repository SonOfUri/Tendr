# Native Intents wallets: API and frontend handover

Updated **11 November 2026**. See [wallet devices and offline recovery](2026-11-11-wallet-devices-recovery.md) for the new key-management flows. Start with the [dashboard frontend handover](2026-11-02-dashboard-frontend.md)
for current deployment status, branch selection, the implementation checklist and development setup.

New live stores use a dedicated P256 passkey and an implicit account inside `intents.near`.
There is no per-store NEAR account, Tendr contract deployment, initial NEAR reserve, or storage
top-up. The private key stays in the merchant's authenticator. The API sends the merchant's
signed withdrawal intent to 1Click, which handles execution. Hosting and swap/withdrawal fees
still apply.

This implements the agreed single-owner scope. The backend and functional console on
`test/api-console` implement the ceremonies below. The redesigned dashboard on `deploy` includes
native wallet integration; preserve its existing design and payment behavior.
Existing test accounts and existing contract accounts keep their current implementation.
No existing live contract account or balance is automatically migrated.

## Authentication and account selection

All routes use the existing dashboard session cookie, `Tendr-CSRF`, `Tendr-Merchant`, and
`Tendr-Livemode: true` headers. Keep the exact header constants from `@tendr/contracts`.
Native writes require an owner role and a fresh login-passkey step-up. Payout signing additionally
requires the dedicated store wallet passkey. Being promoted to owner does not grant access to
another person's wallet. Demoting the wallet owner is refused until an explicit migration exists.

`GET /v1/account/go-live` adds `accountKind: "native_intents"` and `registrationPath` when native
onboarding applies. Its missing reasons include `wallet_passkey` until activation completes.
The two-key checklist belongs to contract accounts. `POST /v1/account/go-live` does not create a
native wallet: use the registration flow below.

`GET /v1/account` returns `account.kind`, `account.capabilities` and a `nativeWallet` object with
`ownerUserId`, `credentialId`, and `publicKey`. These are public identifiers. The account's
`nearAccountId` is its Intents balance identifier, usually `0x…`; it is **not an EVM deposit address**.
Shoppers must pay the address from the checkout quote on its specified chain.

## Create and activate a store wallet

Use `@simplewebauthn/browser` or the existing browser helpers, decoding the JSON options as usual.
The native signing credential is separate from login credentials. Each store has a distinct
WebAuthn user handle and public key, preventing stores owned by one person from pooling balances.
The same authenticator can hold separate login and per-store wallet credentials. The November 6
registration fix is present on both branches (`4b6e431` on console, `acac4fa` on deploy); the backend
still rejects reuse of an actual credential or wallet public key. A phone QR prompt is an
authenticator choice, not a requirement to use a phone. Do not force cross-device registration.

1. `POST /v1/account/native/passkey/options` with `{}` returns registration options directly.
2. Call `startRegistration({ optionsJSON: options })`.
3. `POST /v1/account/native/passkey/verify` with `{ "response": registrationResponse }`.
   This creates an account with status `provisioning`, but sends no NEAR transaction. The response
   contains `accountId`, `publicKey`, `payload`, `options`, and `expiresAt` for activation.
4. Call `startAuthentication({ optionsJSON: activation.options })` with the wallet credential.
5. `POST /v1/account/native/activate` with `{ "response": authenticationResponse }`.
   The backend checks the signature, RP ID, origin, user verification, credential, and challenge;
   it also runs a read-only mainnet simulation. It then marks the account `active` and installs
   the default NEAR USDC settlement configuration.

Registration with `attestation: none` alone is not ownership proof; activation is mandatory.
Activation signs an empty intent and never submits it. Its challenge expires after five minutes.
If interrupted, `POST /v1/account/native/activate/options` returns a fresh challenge; this
invalidates the previous one. Do not repeat registration for a partially registered wallet.
If the dedicated credential itself was lost before activation, contact support instead of
creating an unrelated credential against that existing account.

## Settlement and incoming payments

`PUT /v1/account/native/settlement` with `{ "asset": "nep141:…" }` changes the store default.
The destination stays the store's own Intents balance. This is an owner/step-up protected API
setting, not an on-chain policy. Existing quoted checkouts keep their original settlement.

Use `GET /v1/payment_links/settlement-options` for the live settlement token catalog. Per-link
`settlement_asset: null` inherits the store default; an explicit asset overrides it. Responses
include `settlement_asset`, `settlement_symbol` and `settlement_chain`. The legacy choices on
`GET /v1/account/settlement` are not the complete live catalog.
A Base USDC selection means Base USDC represented inside the store's Intents balance; withdrawal
is a separate action. `GET /v1/account/balances` includes assets referenced by per-link sessions,
as well as default settlement settings and payout history.

## Quote, sign and track a withdrawal

All amounts below are integer strings in the input token's smallest unit. Use token decimals;
do not convert amounts through JavaScript floating point.

`POST /v1/account/native/payouts`:

```json
{
  "asset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount": "1000000",
  "destinationAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "destination": "0x…"
}
```

The API validates tokens, address format, balance and the configured screening policy, then obtains a
1Click `EXACT_INPUT` quote with `depositType: INTENTS`, `refundType: INTENTS` (back to this
store), and `recipientType: DESTINATION_CHAIN`. It permits only a generated intent containing
one transfer of the exact input amount and asset to that quote's deposit account. Arbitrary
client-supplied intents, extra debits and key-management actions are not accepted.

The result includes `id`, `status`, input/output asset IDs, `destinationChain`, `destination`,
the quote (including `minAmountOut`), and `expiresAt`. Display the exact address, chain, spend,
estimated receive amount and minimum received before requesting the signature. The quote may
include partner/provider fees. Read the returned quote; do not promise zero transaction fees.

1. `POST /v1/account/native/payouts/:id/challenge` returns the stored `payload` and WebAuthn
   `options`. Its challenge is SHA-256 of the exact UTF-8 payload. Do not reconstruct the JSON.
2. Call `startAuthentication({ optionsJSON: options })` with the dedicated wallet passkey.
3. `POST /v1/account/native/payouts/:id/submit` with `{ "response": authenticationResponse }`
   returns HTTP 202, not proof of completed execution.
4. Poll `GET /v1/account/native/payouts/:id`; list history with
   `GET /v1/account/native/payouts` → `{ payouts }` (latest 100, no cursor pagination).
   The console polls pending payouts every five seconds; balance reads may be cached for 15 seconds.

Before signing, compare the challenge response's payout fields with the payout the person reviewed,
as `signPayout` in the console does. The current payout view has an intent hash and provider status,
but no dedicated destination transaction/explorer URL. Do not treat the intent hash as a destination
chain transaction hash.

States: `awaiting_signature`, `submitting`, `submitted`, `completed`, `refunded`, `failed`,
`expired`. `completed` means 1Click reports SUCCESS with a destination transaction hash.
It is not an independent destination-chain confirmation proof. `refunded` means the withdrawal
did not complete and 1Click reports refunding its input to the store's Intents balance.

The exact signed bytes are durable before submission. A network timeout keeps the payout open;
the worker polls and can resubmit the same intent/nonce. Repeating `/submit` does not create a
new payout. Never create a replacement just because the UI timed out. Unknown outcomes that
cannot be reconciled remain open for review. A provider FAILED response cannot release a signed
refund for retry while its intent is still valid. The provider may return a deadline longer
than requested; use the returned expiry. Signing is an irrevocable authorization until that
deadline or nonce consumption; no cancellation endpoint is offered for authorized payouts.

## Refund approvals

`POST /v1/refunds` requires a secret key and is not a dashboard-session route. Review routes cover
eligible refunds; a general settled-payment refund button still needs an agreed dashboard endpoint.
Do not expose or reuse a merchant secret key as the dashboard's transport.

Existing merchant/shopper refund logic still creates `refund` proposal drafts after its review
and configured screening-policy checks. For a native account, create a payout using only:

`POST /v1/account/native/payouts`:

```json
{ "proposalId": "prop_…" }
```

The API derives asset, amount and destination from the linked pending refund. Then use the
same payout challenge/sign/submit flow. On completion it emits the existing
`account.proposal.executed` event, and the refund handlers update the payment and notifications.
Repeated requests for the same proposal return its existing payout.

Native refunds currently support returning the same asset to its catalog chain. A different
destination token/chain requiring a new refund conversion stays in review; do not bypass this
by editing a refund amount or destination in the signing request. Draft refunds can be cancelled
through the existing proposal cancel endpoint by the wallet owner before authorization.

## Capabilities and recovery

Native accounts have one wallet owner and threshold 1. Hide contract multisig, signer changes,
legacy contract recovery kits, delayed address allowlists, contract spending/refund limits, automatic sweeps,
and contract upgrades. The API rejects those proposal routes for native accounts. Login/team
permissions are API access controls; they do not change on-chain wallet ownership.

Native wallets now support additional wallet passkeys, revocation, and a separate offline wallet
recovery kit. Follow the [wallet recovery handover](2026-11-11-wallet-devices-recovery.md). The kit
must be enabled before loss; recovering a login/email session alone cannot replace a wallet key.
Do not advertise timed recovery or a second key as multisig: native Intents keys each have full
control. Moving later to a contract wallet requires a separately authorized balance migration.

## Operations and verification

**Frontend audit (2026-11-07):** `test/api-console` at `fc4fee9` implements the dedicated wallet
registration/activation flow and `/dashboard/wallet` for balances, settlement changes, payout
quotes, explicit passkey signing and payout history. Native refund approval links use the same
flow with the proposal ID. Contract-only security/recovery/address pages show the native wallet's
capability limits. The API console includes native routes and prepares WebAuthn follow-up requests
for manual review/submission. These native frontend flows are absent from the redesigned `deploy`
dashboard at `04cd49c`. Port their behavior (principally `85ccc73`) while preserving that branch's
shell and payment-link/theme editors. The API-key page is already on both branches.

On `test/api-console`, run `npm run dev:console` for `http://localhost:3300/settings/api-console`
and `/dashboard`.
That launcher uses the isolated `tendr_api_console` database, Redis DB 8 and simulated payments,
with live writes disabled. Simulated account state is checkpointed to the ignored
`.keyvault/api-console-state.bin` after mutations and restored before workers start. Keep that
file with the console database when backing it up. Existing basic simulated accounts and verified
deposit balances are recovered once from the database; missing checkpoints for advanced contract
state stop startup rather than silently erasing it. The local inbox remains `/settings/local-mail`.

The same branch has `npm run dev:console:live` for a loopback frontend at the approved production
app origin using a dedicated Chrome profile and the real API. It requires private web configuration
and can move real funds. The commands/config support are not yet on `deploy`; follow the main
handover before porting them. Read `docs/api-console.md` on the console branch for full setup.

On November 7, Railway API and worker already have `LIVE_ACCOUNT_DRIVER=native_intents` and
`LIVE_MODE_ENABLED=true`; native migrations are deployed. Gasless sponsorship and fee sweeps are
off. For another environment, apply both native-wallet migrations, regenerate Prisma and deploy
the worker with the API. `LIVE_MODE_ENABLED` remains the platform switch for onboarding and writes.

Native merchant wallets do not require `MERCHANT_ACCOUNT_CODE_HASH_LIVE`, a funded `tendr.near`
parent, a funding key installed in Meteor, GCP KMS, or a funded Tendr NEAR relayer. Other
subsystems still retain their existing key vault configuration. 1Click credentials are required.

**Hackathon configuration, confirmed November 7:** Chainalysis is omitted at the operator's request.
`SCREENING_MODE=disabled` is set on both API and worker. Live checkout, refunds and native payouts
proceed without sanctions screening. Address checks and payment verification still run.
The audit trail records `session.screening_skipped`, `payment.screening_skipped`, and
`merchant_account.payout_screening_skipped`; these are not approvals, risk scores or screening
results. Previously held payments remain held. Test-mode screening fixtures stay active.

The default remains `SCREENING_MODE=chainalysis`, which fails closed on missing keys or provider
failure. Restoring that mode requires supported API access on both services. Disabled mode never
caches approvals, so subsequent checks use the provider after re-enabling; completed payments
are not retroactively screened. The UI must not label skipped screening as a passed check. Native
wallet setup already works in the console; its integration into the redesigned dashboard remains.

Read-only mainnet verification (creates an ephemeral key, signs empty intents, never broadcasts):

```sh
npm run onchain:verify:native -w @tendr/api
```

The integration tests use software authenticators, a real test database, and fake provider/RPC
responses. They cover separate stores, ownership proof, RP/origin/UV checks, replay, permissions,
mainnet gating, exact payload validation, timeout recovery, refund completion and legacy guards.
On November 7 the merchant reported successful live payment-link receipt and withdrawal. This is
user-reported evidence for the exercised flow, not verification of every chain, asset, browser or
refund case. No new funded test was run for this documentation audit. Read-only simulation alone
does not establish a funded result. The public app domain still has a hosting/DNS issue; the local
live console does not establish public dashboard availability (see the main handover).

Protocol references: [account abstraction](https://docs.near-intents.org/integration/verifier-contract/account-abstraction),
[WebAuthn signatures](https://docs.near-intents.org/integration/verifier-contract/signing-intents),
[1Click signed intent execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution).
