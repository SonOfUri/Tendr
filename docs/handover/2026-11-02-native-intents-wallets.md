# Native Intents wallets: API and frontend handover

New live stores use a dedicated P256 passkey and an implicit account inside `intents.near`.
There is no per-store NEAR account, Tendr contract deployment, initial NEAR reserve, or storage
top-up. The private key stays in the merchant's authenticator. The API sends the merchant's
signed withdrawal intent to 1Click, which handles execution. Hosting and swap/withdrawal fees
still apply.

This implements the agreed single-owner hackathon scope. It changes the API; the dashboard
still needs the following ceremonies and capability handling before this flow is usable there.
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

The live settlement token catalog and per-payment-link `settlement_asset` selection are unchanged.
A Base USDC selection means Base USDC represented inside the store's Intents balance; withdrawal
is a separate action. `GET /v1/account/balances` includes assets referenced by per-link sessions,
as well as default settlement settings and payout history.

## Quote, sign and track a withdrawal

All amounts below are integer strings in the input token's smallest unit. Use token decimals;
do not convert amounts through JavaScript floating point.

```json
POST /v1/account/native/payouts
{
  "asset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "amount": "1000000",
  "destinationAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "destination": "0x…"
}
```

The API validates tokens, address format, balance and sanctions screening, then obtains a
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
3. `POST /v1/account/native/payouts/:id/submit` with `{ "response": authenticationResponse }`.
4. Poll `GET /v1/account/native/payouts/:id`; list history with
   `GET /v1/account/native/payouts`.

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

Existing merchant/shopper refund logic still creates `refund` proposal drafts after its review
and screening checks. For a native account, create a payout using only:

```json
POST /v1/account/native/payouts
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
recovery kits, delayed address allowlists, contract spending/refund limits, automatic sweeps,
and contract upgrades. The API rejects those proposal routes for native accounts. Login/team
permissions are API access controls; they do not change on-chain wallet ownership.

This release has no wallet-key replacement or recovery ceremony. Recommend a synced passkey
and explain that recovering a login/email session does not recover a lost wallet credential.
Do not advertise timed recovery or a second key as multisig: native Intents keys each have full
control. Moving later to a contract wallet requires a separately authorized balance migration.

## Operations and verification

Set `LIVE_ACCOUNT_DRIVER=native_intents` on both API and worker. Apply both native-wallet
migrations, regenerate Prisma, and deploy the worker with the API. `LIVE_MODE_ENABLED` remains
the platform switch; it must be open for onboarding and live writes. Keep gasless sponsorship
and fee sweeps off unless separately configured and verified.

Native merchant wallets do not require `MERCHANT_ACCOUNT_CODE_HASH_LIVE`, a funded `tendr.near`
parent, a funding key installed in Meteor, GCP KMS, or a funded Tendr NEAR relayer. Other
subsystems still retain their existing key vault configuration. 1Click credentials and working
screening are still required. Missing screening fails closed; it is not silently disabled.

Read-only mainnet verification (creates an ephemeral key, signs empty intents, never broadcasts):

```sh
npm run onchain:verify:native -w @tendr/api
```

The integration tests use software authenticators, a real test database, and fake provider/RPC
responses. They cover separate stores, ownership proof, RP/origin/UV checks, replay, permissions,
mainnet gating, exact payload validation, timeout recovery, refund completion and legacy guards.
A real browser registration and funded end-to-end payment/withdrawal still need the merchant's
wallet interaction and funds; the read-only simulation does not establish those results.

Protocol references: [account abstraction](https://docs.near-intents.org/integration/verifier-contract/account-abstraction),
[WebAuthn signatures](https://docs.near-intents.org/integration/verifier-contract/signing-intents),
[1Click signed intent execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution).
