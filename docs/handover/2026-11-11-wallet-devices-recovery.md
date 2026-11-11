# Native wallet devices and recovery

Updated 11 November 2026. Extends [native wallets](2026-11-02-native-intents-wallets.md) and
complements [login recovery](2026-11-11-login-recovery.md). Applies to active live
`native_intents` wallets. Existing contract accounts retain their separate recovery flow.

## Product behavior

The designated wallet owner can enable additional P-256 passkeys, register an offline Ed25519
recovery kit, revoke keys, and recover the same wallet after losing passkeys. The Intents account
ID and balances stay in place. Every enabled key has full control, including key changes. This
is not multisig, a timelock, social recovery, or wallet control through email.

Existing wallets are migrated to a public-key registry with their original credential. Deployment
does not enroll any backup, sign a transaction, change an address, or move funds. Each owner must
save and authorize a kit before losing the wallet passkey. Login recovery codes cannot do this.

The functional UI is `NativeWalletSecurity.tsx` inside `/dashboard/wallet`, also linked from the API
console. Keep the production dashboard's surrounding design. The component has scoped responsive
styles. Mount it with the merchant ID as its React key so another store never inherits kit state.

## Authentication and endpoints

Use the existing dashboard session, CSRF header, merchant header and `Tendr-Livemode: true`.
Only the designated wallet owner may use these endpoints, even if another member is also an
owner. Mutations and the operation-detail endpoint require recent login-passkey step-up. Key
approval additionally requires an existing wallet key; an email session cannot authorize funds.

Base: `/v1/account/native/keys`.

| Method / suffix                  | Request                                                                | Response / purpose                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET` base                       | —                                                                      | `accountId`, `rpId`, `contract`, public `keys`, latest 20 `operations`                                                       |
| `POST /operations`               | `{kind:"add_passkey",label}`                                           | Request + `registrationOptions`                                                                                              |
| `POST /operations`               | `{kind:"add_recovery",label,publicKeyB64,saved:true}`                  | Request + `proofPayload`; replaces previous kit after approval                                                               |
| `POST /operations`               | `{kind:"recover",label,recoveryKeyId}`                                 | Request + `registrationOptions`; snapshots old Tendr passkeys to revoke                                                      |
| `POST /operations`               | `{kind:"revoke",keyId}`                                                | Request awaiting approval; another active passkey must remain                                                                |
| `GET /operations/:id`            | —                                                                      | Current request and registration/proof options needed to resume                                                              |
| `POST /operations/:id/register`  | `{response: RegistrationResponseJSON}`                                 | Pending candidate + assertion `proofOptions` / `proofPayload`                                                                |
| `POST /operations/:id/prove`     | `{response: AuthenticationResponseJSON}` or `{signatureB64}` for a kit | Candidate possession proved; awaiting existing-key approval                                                                  |
| `POST /operations/:id/challenge` | `{}`                                                                   | Immutable `payload`, account, contract, added key, removed keys, plus wallet assertion `options` or registered `recoveryKey` |
| `POST /operations/:id/submit`    | `{response}` or `{signatureB64}` for recovery                          | `202`; request remains pending until final on-chain confirmation                                                             |
| `POST /operations/:id/cancel`    | `{}`                                                                   | Cancel only while `canCancel:true`; issued signing payloads must expire on-chain                                             |

Public key rows expose `id`, `kind` (`passkey`/`recovery`), `label`, `status`
(`pending`/`active`/`revoked`), `publicKey`, and timestamps. No private material is returned.
Operation rows expose IDs, kind, label, status, candidate/recovery/revoked key IDs, expiry,
confirmation time, intent hash and `canCancel`. Do not infer completion from an intent hash.
The legacy `nativeWallet.credentialId`/`publicKey` identify the original credential, which may
now be revoked. Use the key registry and the server's full `allowCredentials` list for signing.

## Screen flows

**Another device:** synced credentials may already work without enrollment. Otherwise create a
new wallet credential on the new device and prove possession with an assertion. `attestation:none`
alone is insufficient. The pending request appears when the same owner opens this store on the
old device. Show the label and public-key fingerprint on both devices. Approve using a key already
enabled for this wallet. The new candidate cannot approve itself. Do not force `internal` transport;
the request includes stored transports plus `hybrid` for cross-device authentication.

**Enable a kit:** generate 32 random bytes in the browser. Download a versioned JSON file containing
`type:"tendr-native-wallet-recovery"`, `version:1`, `accountId`, `rpId`, and base32/checksummed `secret`.
Use `native-wallet-recovery.ts`; do not reuse login codes or the legacy contract recovery signing
format. Require download and the requested secret group before proceeding. Send only the public
key and signature over the domain-separated possession proof. Then review and approve the
on-chain addition using an existing wallet passkey. A replacement kit atomically revokes the old
kit. Clearly show that a downloaded but unconfirmed kit cannot recover the wallet.

**Recover:** sign in to the same account first (using login recovery if needed), paste the saved
file in browser memory, check its account/RP and registered public key, create and prove a new
P-256 credential, review all old Tendr passkeys to revoke, and sign the exact UTF-8 intent payload
with the kit. This is `raw_ed25519`, not a signature over SHA-256. The API never receives the
secret. Recovery adds the replacement and removes old Tendr passkeys atomically, including the
original implicit key. The kit remains enabled; offer replacement after recovery if exposed.

**Remove:** show the exact key. Another active passkey must authorize removal and at least one
passkey must remain. Revoking a synced credential revokes it across its synced devices. Tendr
lists keys it registered; independently added external Intents keys are outside this registry.
Do not claim this feature manages arbitrary external keys.

## Pending states and errors

`registering → proving → awaiting_signature → submitting → confirmed` (revoke starts at
`awaiting_signature`). `expired` and `cancelled` are terminal. Only one pending operation is
allowed per wallet. Registration/proof has a ten-minute window; signing has at most five minutes.
Poll the key list every five seconds while pending. The worker checks every 15 seconds.

After a payload has been issued, its nonce is never replaced. A provider timeout preserves the
exact signed bytes for retry. Final-block nonce consumption and expected key presence/removal
must both agree before DB activation. An unused nonce can expire only after a final chain block
past its deadline, not just the API's clock. An issued payload can be submitted directly by a
client, so even an apparently unsigned request cannot be cancelled early. If the chain state is
inconsistent, preserve the request for investigation instead of granting or reissuing keys.

`400`: invalid proof/input. `401 STEP_UP_REQUIRED`: confirm a login passkey. `403`: wrong owner or CSRF. `404`: unknown scoped
request/key. `409`: wrong mode, already pending, stale request, credential reuse, missing enabled kit, or
last-key/self-revocation protection. Handle `STEP_UP_REQUIRED` through the shared login helper.
Never automatically regenerate a new request after a submission timeout. Reload and poll its ID.

## Email and implementation references

`wallet_keys_changed` is queued transactionally only after confirmation, once per event to the
wallet owner's verified email. Data: `at`, `change`, `account`, `url` → `/dashboard/wallet`.
The copy distinguishes passkey addition, kit replacement, recovery and revocation. Design an
urgent security notice with wallet identifier, time, action and review CTA; never include kit
secrets, signatures or recovery codes. Preserve HTML and plain-text alternatives on `deploy`.

API: `native-key-operations.ts`, `native-wallet-keys.ts`, `native-key-relay.ts`,
`routes/native-wallet-keys.ts`. Browser: `native-wallet-keys.ts`, `native-wallet-recovery.ts`,
`NativeWalletSecurity.tsx`. The browser validates the exact reviewed key-only payload before
signing. Existing payout assertions now select any active wallet passkey and persist that key's
counter. Login/wallet registration share a transaction lock to prevent cross-role credential reuse.

Migration: `20261111210000_native_wallet_recovery`. Deploy API, worker and web together, regenerate
Prisma, and retain the existing production WebAuthn RP/origin. `INTENTS_RELAY_URL` defaults to the
NEAR Intents message bus. Optional `INTENTS_RELAY_API_KEY` supplies its partner JWT. The currently
verified endpoint accepts the key-only requests without it; provider requirements can change.
Do not send key-management intents through 1Click's `swap_transfer` endpoint or grant Tendr a
wallet private key. No new paid service or per-store account funding is introduced.

## Verification

Tests cover possession, full approval flow, unchanged wallet identity, original/backup revocation,
raw recovery signing, key replacement, unknown broadcasts, final-block expiry, cross-role reuse,
owner/mode boundaries, CSRF, step-up, parallel requests, and browser review/secret handling.
`verify-native-key-management-mainnet.ts` runs read-only protocol simulations. The separate
`verify-native-key-relay-mainnet.ts --ephemeral-only` explicitly creates a fresh unfunded account
and exercises key-only relay transactions; it never loads a merchant account or transfers funds.

Primary protocol references: [account abstraction](https://docs.near-intents.org/integration/verifier-contract/account-abstraction),
[relay RPC](https://docs.near-intents.org/integration/market-makers/message-bus/rpc), and
[verifier source](https://github.com/near/intents). Do not promise that passkey provider syncing,
lost-device recovery without a pre-enabled kit, or email-only wallet recovery is guaranteed.

Verified mainnet relay lifecycle on 11 November 2026 with generated account
`0x3eb3a8afa1fbf56cc24180abb2172e593834c16a`: backup/kit enable, original key removal,
kit-authorized replacement, and replacement-key kit removal all confirmed via final-block
nonce/key reads. No merchant data was loaded and no funds moved. Focused backend suite: 251
passing tests; browser security/payout/crypto suite: 11 passing tests.
