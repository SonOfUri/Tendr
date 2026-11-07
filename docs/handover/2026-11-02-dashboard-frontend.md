# Tendr dashboard frontend handover

Updated **7 November 2026**. Audience: the developer building the merchant dashboard in `apps/web`.
This is the current entry point for frontend work. It supersedes the deployment assumptions and
"missing screens" lists in earlier versions of this handover. The filename is retained for existing links.

## Start here

The live backend supports native passkey wallets, payment links, incoming payments, withdrawals,
settlement selection and API-key management. **The merchant reports successfully receiving a live
payment through a payment link and withdrawing funds on 7 November.** Preserve those working
flows when integrating them into the redesigned dashboard.

There are two frontend implementations to reconcile:

| Branch / audited revision              | What to use it for                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/deploy` at `04cd49c`           | Implementation baseline: redesigned dashboard and auth screens, payment-link list/detail/editor, theme list/editor, shared UI components, API-key page and deployed backend. Railway builds this branch.                     |
| `origin/test/api-console` at `fc4fee9` | Working functional references: native-wallet setup, settlement and withdrawals; native refund approvals; capability guards; per-link settlement selector; isolated API console and local frontend connected to the live API. |

The revisions above identify code reviewed for this handover, not a requirement to reset a newer
checkout. Fetch before starting and review any subsequent changes. `main` is not the deployment baseline.

```bash
git fetch origin
git switch -c feat/dashboard origin/deploy
```

Keep the redesigned shell and existing editors from `deploy`. Port the native-wallet and settlement
behavior from the console branch into that design. A wholesale replacement with the console
frontend would lose the richer payment-link/theme editors and the redesigned navigation.
Submit a PR against `deploy`; pushing directly to that branch can deploy immediately.

## Current live status and evidence

Configuration was read from the Railway API and worker on 7 November; no credentials are included here.

| Area                     | Current state and frontend implication                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live processing          | `LIVE_MODE_ENABLED=true`; new live accounts use `LIVE_ACCOUNT_DRIVER=native_intents`. Do not hard-code a "live disabled" banner. Read account/checklist responses.                                                                                                                                |
| Verification             | Merchant-reported live payment-link receipt and withdrawal succeeded. This establishes those exercised flows, not every chain, token, refund, wallet/browser or integration. No new money movement was performed for this documentation review.                                                   |
| Email                    | `MAIL_DRIVER=resend`; the merchant fixed domain DNS and reported signup mail arriving. Resend verification is no longer an outstanding setup blocker.                                                                                                                                             |
| Screening                | `SCREENING_MODE=disabled`, an operator-selected hackathon configuration. Live funds are **not sanctions-screened**. Do not label skipped screening as a passed check; existing held payments remain held.                                                                                         |
| Gas sponsorship / sweeps | `GASLESS_LIVE_ENABLED=false`, `FEE_SWEEP_ENABLED=false`. Do not promise active gasless sponsorship or automatic sweeps from a saved preference alone.                                                                                                                                             |
| API / checkout           | `https://api.usetendr.tech` and `https://pay.usetendr.tech`. API readiness and the new authenticated API-key route were checked on 7 November. Shopper links stay on the pay host.                                                                                                                |
| Public dashboard         | Configured origin is `https://app.usetendr.tech`, RP ID `usetendr.tech`. On 7 November the public domain returned Vercel `DEPLOYMENT_NOT_FOUND`, even though Railway's web deployment succeeded. Public dashboard DNS/hosting is an outstanding operator task.                                    |
| Working live console     | A dedicated Chrome profile maps the app origin to a loopback frontend while calling the real API. This is how the functional console is used; it does not establish that the public app domain works. See development setup below.                                                                |
| Infrastructure           | HODL workspace, Railway `tendr` project; API, worker, web, Postgres, Redis. API/worker use `KEYVAULT_DRIVER=env`; assets use `ASSET_STORE_DRIVER=s3` with API-served assets. Native wallet onboarding does not require GCP billing, funding `tendr.near`, or deploying a per-store NEAR contract. |

A missing frontend feature must not be presented as a disabled backend capability. Conversely,
a successful deployment or a UI preview is not evidence that a payment executed.

## Delivery checklist: what actually needs work

| Priority | Work                                                            | Existing code / completion requirement                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Integrate native wallet setup and account capabilities          | `deploy` still has contract-oriented onboarding/checklist controls. Port `NativeWallet.tsx`, `lib/native-wallet.ts`, the native fields in `lib/api.ts`, and account-home integration from the console branch. Show create, resume activation, active and non-owner states.             |
| 1        | Integrate live withdrawals and default settlement               | Add `/dashboard/wallet` or integrate its behavior into the existing wallet/withdraw/payout screens. Dispatch using `account.kind`; preserve the contract flow for contract accounts. Review and sign the exact native payout, then track its outcome.                                  |
| 1        | Integrate native refund approval and capability guards          | Port native handling in approvals list/detail and the shell's `AccountCapabilityGate`. Hide or explain unavailable contract-only actions, including on direct navigation. Keep login roles separate from wallet ownership.                                                             |
| 1        | Add per-link settlement selection to the redesigned link editor | Backend and console selector exist. `deploy`'s `payment-link-types.ts` and `payment-link-form.ts` currently omit settlement fields. Add default/custom selection without dropping its fee/gas/theme overrides, totals or linked payments.                                              |
| 2        | Finish presentation and regression coverage                     | API-key management is now implemented on both branches. Refine it with the existing design, preserving its permissions, context isolation and one-time secret handling. Exercise payments, webhooks, settings and team flows with real API data.                                       |
| 2        | Extend themes only where required                               | Theme list/editor already exists on `deploy`: presets, website brand import, basic branding, logo upload, custom CSS, validation, preview, publish/default. Advanced block/success-block/font editing and connected-store brand import UI are additional work; backend support exists. |
| Operator | Restore public dashboard origin                                 | Correct the app domain's hosting/DNS before public-browser acceptance. Do not change production RP ID or widen CORS to work around it.                                                                                                                                                 |

General refunds from an ordinary settled-payment detail, dashboard analytics/time series, global
payment search and CSV export still need explicit backend/product contracts where no matching
endpoint exists. Do not invent figures from a single page of records. Shopify now has a separate,
single-store connector pilot with a local simulator ([setup](../shopify-connector.md)); it has not
been validated on an approved Shopify store and is not a dashboard Connect integration;
WooCommerce source exists but its public ZIP release was still unpublished on 7 November.
Neither is a prerequisite for the native dashboard work.

## Source map and branch-specific references

Paths are relative to the repository root. Read route declarations and shared schemas before
changing a request; some API fields use snake_case and native-wallet fields use camelCase.

| Source                                                                    | Responsibility                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/`                                                    | Authoritative methods, principal types, permissions and step-up requirements.                                                                                                                                  |
| `packages/contracts/src/`                                                 | Roles, scopes, schemas, statuses, payment links and themes.                                                                                                                                                    |
| `apps/web/src/components/dashboard/DashboardShell.tsx`                    | Session boot, store/mode selection, navigation, passkey gate, sign-out. `deploy` also supports an explicitly entered UI preview.                                                                               |
| `apps/web/src/components/dashboard/common.tsx`                            | `useLoad`, `useAction`, display helpers. `deploy` has stale-response protection in `useLoad`; the console branch's simpler helper does not. Preserve the stronger behavior and protect custom polling as well. |
| `apps/web/src/lib/api.ts`                                                 | Cookie auth, CSRF, context headers, error parsing and response types. `deploy` already supports `formData` and `AbortSignal`; retain both when adding native types.                                            |
| `apps/web/src/lib/webauthn.ts`                                            | Login-passkey registration, sign-in, step-up and contract challenge signing.                                                                                                                                   |
| `apps/web/src/lib/payments.ts`, `assets.ts`, `asset-registry.ts`          | Payment/refund types, exact amount formatting, known token metadata and explorer links. Provider catalogs supplement the static registry.                                                                      |
| `apps/web/src/lib/proposals.ts`, `actions.ts`                             | Existing contract proposal creation, signing, cancellation and action summaries.                                                                                                                               |
| `apps/web/src/lib/payment-link-types.ts`, `payment-link-form.ts`          | Redesigned link DTO/form logic on `deploy`; extend with settlement fields.                                                                                                                                     |
| `apps/web/src/lib/themes.ts`                                              | Theme draft state, validation mapping and editor helpers on `deploy`.                                                                                                                                          |
| `apps/web/src/components/dashboard/ui.tsx`, `Select.tsx`, `dashboard.css` | Redesigned dashboard primitives and responsive monochrome styling on `deploy`; use these with shared `packages/ui`.                                                                                            |
| `apps/web/src/app/dashboard/api-keys/`                                    | Working create/list/revoke page and component tests on both branches.                                                                                                                                          |

Native references **on `origin/test/api-console`**, principally commit `85ccc73`:

- `apps/web/src/components/dashboard/NativeWallet.tsx` and `NativeWallet.test.tsx`.
- `apps/web/src/lib/native-wallet.ts`: `registerWallet`, `activateWallet`, `signPayout`.
- `apps/web/src/app/dashboard/wallet/page.tsx`.
- Native branches in account home, `withdraw/page.tsx`, `settings/payout/page.tsx`,
  `approvals/page.tsx`, `approvals/[id]/page.tsx`, and the shell capability guard.
- `apps/web/src/app/dashboard/payment-links/SettlementSelector.tsx`, `PaymentLinkForm.tsx`,
  and `apps/web/src/lib/dashboard-payment-links.ts` for per-link settlement behavior.
- `docs/api-console.md` and the console launchers; these files/scripts are not present on the
  audited `deploy` revision. Read that document from the console branch.

The backend same-authenticator registration fix is already on both branches (`4b6e431` on console,
`acac4fa` on deploy). A wallet credential may be created on the same device/authenticator that
holds a login credential; they must still be distinct credentials and keys.

## Session, context and permissions

Use `api()` for dashboard requests. It sends `credentials: 'include'`, `Tendr-Merchant`,
`Tendr-Livemode` and, on mutations, `Tendr-CSRF`. `GET /v1/me` uses `{ store: false }` and returns
session data and the CSRF token. Keep the in-memory CSRF response handling: the API and app are
different subdomains, so reading an app-host cookie alone is insufficient.

Store selection is a per-tab preference in `sessionStorage`. The server validates membership.
Use merchant ID, mode, resource ID and filters in data-loading keys. Clear old results/drafts on
context changes, abort or ignore stale responses, and pass an explicit captured `store` to
multi-step ceremonies so a dropdown change cannot retarget a pending signature or write.

Email deep links may include `?store=<id>&mode=...`; preserve membership checks, parameter cleanup
and the sign-in return route. An unavailable resource must not silently fall back to another store.

| Scope                  | Resources                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store + test/live mode | Accounts, balances, sessions, payments, payment links, proposals, withdrawals, API keys and webhook endpoints.                                     |
| Store-wide             | Team membership, checkout domains, fee/gas defaults, email preferences, themes and theme assets. Selecting Test does not isolate changes to these. |
| Person                 | Login passkeys and session operations (`store: false`).                                                                                            |

Use `can()` / `ROLE_PERMISSIONS` from `@tendr/contracts`; backend authorization remains authoritative.

| Role    | Relevant capabilities                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer  | Account/payment reads and other `account:read` routes.                                                                                                    |
| Finance | Viewer plus `money:request`, including payment-link writes and eligible refund/proposal requests.                                                         |
| Admin   | Finance plus settings, team management, API keys and webhook management/resend.                                                                           |
| Owner   | Admin plus security and native-wallet management. Native signing additionally requires the designated wallet owner and their dedicated wallet credential. |

A contract signer's status is separate from their dashboard role. For native wallets, check
`nativeWallet.ownerUserId === me.user.id` as well as the owner role. Adding a teammate or promoting
another owner does not give them control of the wallet. The API enforces these boundaries.

Use `withStepUp()` for a recent **login-passkey** assertion; it handles `STEP_UP_REQUIRED` and
retries once. Wallet signing is a separate ceremony. Browser callbacks or a successful signature
submission must not be displayed as completed payment/withdrawal execution.

Dashboard requests authenticate with cookies, not a merchant secret key. The API-key screen is
the intentional one-time secret display; do not reuse that key to authenticate dashboard features.

Connecting WooCommerce to an existing store goes directly from store selection to passkey approval.
Test-account provisioning and test payout setup do not gate that connection. The plugin starts in
Test mode and checks `/v1/connect/status` with the selected mode's connection key before enabling
Live. A failed test account does not invalidate an active live wallet or its settlement settings.

## Account type and native-wallet flow

Read `GET /v1/account` for the selected mode and `GET /v1/account/go-live` for live onboarding.
The latter describes live readiness even when requested while the dashboard is showing Test.

| Response                                                      | Behavior                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Existing `account.kind === 'native_intents'`                  | Use native setup/settlement/payout paths and `nativeWallet` ownership.                  |
| No live account and `goLive.accountKind === 'native_intents'` | Offer native registration; use returned `registrationPath`.                             |
| `account.kind === 'contract'`                                 | Preserve contract proposals, saved-address restrictions, limits and supported recovery. |
| `checklist.missing` contains `live_mode_unavailable`          | Explain backend availability and disable live writes. Do not bypass the switch.         |

`account.capabilities` contains `multisig`, `timedRecovery`, `contractLimits`, `autoSweep`,
`nativePasskeyPayouts`. Native accounts have threshold 1 and no multisig, wallet-key replacement,
wallet recovery, delayed address allowlist, contract limits or automatic sweeps. Gate controls and
direct routes, not just sidebar links. Login recovery does not recover a lost wallet passkey.

`nearAccountId` on a native account is the Intents balance identifier (often `0x…`). It is not an
external EVM receiving address. Checkout's quoted deposit address belongs to a specific payment
route; external withdrawal addresses belong to the selected destination chain.

### Register and activate

1. With a live store context, call `POST /v1/account/native/passkey/options` and pass the returned
   options to `startRegistration({ optionsJSON })`.
2. Send `{ response }` to `POST /v1/account/native/passkey/verify`. The wallet is provisioning,
   not yet active. Registration returns activation options as well.
3. Sign activation options with the dedicated wallet credential, then send `{ response }` to
   `POST /v1/account/native/activate`.
4. Refresh account/readiness/balances. Activation installs the default NEAR USDC settlement.
   If interrupted after registration, call `POST /v1/account/native/activate/options` and resume;
   do not register another wallet against the existing account.

Reuse `registerWallet`/`activateWallet` from the console reference; its activation helper requests
fresh options. Activation proves ownership with an empty intent and a read-only mainnet simulation;
it does not transfer money. The challenge expires after five minutes.

Explain login versus wallet passkeys before the ceremony. A phone QR prompt is an authenticator
choice; do not force it or claim a passkey is on the computer merely because email signup happened
there. The same system authenticator can hold separate login and per-store wallet credentials.

### Default settlement and per-link overrides

Use `GET /v1/payment_links/settlement-options` for current selectable assets:

```ts
type SettlementOptions = {
  livemode: boolean;
  tokens: { asset: string; symbol: string; chain: string; decimals: number }[];
  store_default: {
    asset: string;
    symbol: string | null;
    chain: string | null;
    payout_mode: string;
  } | null;
};
```

The API uses the simulated catalog in test mode and the provider catalog in live mode. Do not use
hard-coded live token lists or treat symbols alone as unique. Group by chain and select by asset ID.

For native store defaults, `PUT /v1/account/native/settlement` accepts `{ asset }`, requires the
wallet owner and login step-up, and returns `{ asset, payoutMode: 'intents' }`. Contract defaults
still use the settlement/proposal flow. `GET /v1/account/settlement` retains a small legacy choices
list; use the provider catalog for the full native/per-link selector.

Payment-link create/update accepts `settlement_asset: '<asset ID>'`; `null` means inherit the store
default. Responses include `settlement_asset`, `settlement_symbol`, `settlement_chain`. An explicit
link asset needs an active account but does not require a store default. Already-created sessions
keep their pinned asset/recipient when a link or default changes.

The chain label describes the selected token's source chain. For example, Base USDC settlement
means Base USDC represented **inside the merchant's Intents wallet**, not an automatic transfer to
an external Base address. Withdrawal is a separate operation. Neither a link form nor its text may
substitute a different recipient or payment address.

### Withdraw and track the result

Amounts are integer strings in the input token's smallest units. Use `parseUnits` and catalog
decimals; keep output/minimum amounts and fees token-aware.

`POST /v1/account/native/payouts`:

```json
{
  "asset": "<asset ID in the wallet balance>",
  "amount": "1000000",
  "destinationAsset": "<asset ID from the catalog>",
  "destination": "<address on that asset's destination chain>"
}
```

Creation returns HTTP 201 with a payout including `id`, `status`, `asset`, `amount`,
`destinationAsset`, `destinationChain`, `destination`, `proposalId`, `quote`, `expiresAt`,
`intentHash`, `providerStatus`, `createdAt`. Show full destination/chain, input amount, quoted
output and minimum output before enabling an explicit sign action.

1. `POST /v1/account/native/payouts/:id/challenge` returns payout details, `payload` and WebAuthn
   `options`. Compare the returned payout with what the person reviewed. Do not reconstruct payload JSON.
2. `startAuthentication({ optionsJSON: options })` uses the wallet credential.
3. `POST /v1/account/native/payouts/:id/submit` with `{ response }` returns HTTP 202.
4. Poll `GET /v1/account/native/payouts/:id`; history is `GET /v1/account/native/payouts` →
   `{ payouts }` (latest 100, no cursor pagination currently). Refresh balances after outcomes;
   account balances can be cached for 15 seconds. The console polls pending payouts every five seconds.

States: `awaiting_signature`, `submitting`, `submitted`, `completed`, `refunded`, `failed`, `expired`.
`completed` means the backend received provider success with a destination transaction hash;
`refunded` means the withdrawal input was returned to the Intents wallet. The current payout view
exposes provider status and intent hash but no dedicated destination explorer URL; do not fabricate
one from the intent hash. A richer withdrawal receipt needs a response-contract extension.

Use returned `expiresAt`; provider deadlines can differ from requested deadlines. An expired
unsigned quote needs a new quote and review. A timeout after signing is an unknown/pending outcome:
read the same payout, do not create a replacement payment. Resubmission uses the same payout and
signed intent. There is no cancellation endpoint for an authorized native payout.

### Refunds and review

`POST /v1/refunds` is secret-key-only. Do not put a secret key in the dashboard to implement a
general refund button. Dashboard review routes handle eligible returns and cancellation; ordinary
settled-payment refund creation still needs an agreed dashboard endpoint.

For an existing native refund proposal, create a payout with **only** `{ proposalId: 'prop_…' }`.
The server derives amount, asset and recipient from the refund. Review and sign through the same
native payout flow. Repeating creation for that proposal returns its existing payout. Same-asset
returns to the token's catalog chain are supported; unsupported conversion cases stay in review.

Preserve owner-only legal acknowledgement and its exact phrase where required. There is no held
payment "release to settlement" endpoint. Refund proposals may be cancelled through the existing
proposal cancel flow before authorization; never offer cancellation of an already signed payout.
See [the native wallet handover](2026-11-02-native-intents-wallets.md) for the detailed contract.

## API map for the remaining screens

All dashboard calls below use cookie authentication and the selected store/mode unless stated
otherwise. Routes are authoritative; the SDK is not the dashboard transport.

| Area                  | Contract and permissions                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account               | `GET /v1/account`, `/v1/account/balances`, `/v1/account/settlement`, `/v1/account/go-live`; `account:read`. `POST /v1/account/retry` and `POST /v1/account/go-live` are owner/step-up contract operations, not native activation.                                      |
| Payments              | `GET /v1/payments`, `/v1/payments/:id`; `account:read`. List filters: `status`, `created_from` inclusive, `created_to` exclusive, `payment_link_id`, `limit` 1–100, `starting_after`. Returns `{payments, has_more, next_cursor}`. No free-text search.                |
| Payment links         | `GET/POST /v1/payment_links`; `GET/PATCH/DELETE /v1/payment_links/:id`; `GET /v1/payment_links/settlement-options`. Read: `account:read`; write: `money:request`, no step-up. List returns `{data, has_more}`; cursor is last row ID.                                  |
| Contract proposals    | `GET/POST /v1/account/proposals`; `GET /v1/account/proposals/:id`; `POST .../:id/challenge`, `/approve`, `/cancel`. Use existing proposal helpers and backend permission/action checks. Native refund signing uses native payouts instead.                             |
| Contract policy reads | `GET /v1/account/saved-addresses`, `/v1/account/limits`; changes are proposals. These are not native spending controls.                                                                                                                                                |
| Review                | `GET /v1/review`; `POST /v1/review/:paymentId/acknowledge-legal` (owner + step-up); `POST .../:paymentId/refund` and `/v1/review/refunds/:refundId/cancel` (`money:request` + step-up).                                                                                |
| Checkout settings     | `GET/PATCH /v1/settings/checkout`; `settings:manage`, PATCH step-up. Store-wide checkout domains, fee/gas defaults, notification email and payment emails.                                                                                                             |
| Connected sites       | `GET /v1/connections`, `DELETE /v1/connections/:id`; settings permission, removal step-up. WooCommerce Connect currently supplies these; Shopify is not an accepted platform.                                                                                          |
| Team                  | `GET /v1/team`, `POST /v1/team/invites`, `PATCH /v1/team/:membershipId`, `GET /v1/team/:membershipId/signer-keys`. Preserve existing restrictions; a role change is not native wallet ownership transfer.                                                              |
| Webhooks              | `GET/POST /v1/webhooks/endpoints`, `DELETE /v1/webhooks/endpoints/:id`; `POST .../:id/rotate`, `/test`; `GET .../:id/deliveries`; `POST /v1/webhooks/deliveries/:id/resend`. Management needs `settings:manage`; create/rotate step-up; resend uses `webhooks:resend`. |
| API keys              | `GET/POST /v1/api_keys`, `DELETE /v1/api_keys/:id`; `settings:manage`, create/revoke step-up. POST `{name, scopes}` → `{api_key, secret}`; GET `{api_keys}`; DELETE `{api_key}`. Store/mode-specific, manually issued keys only.                                       |
| Themes                | `GET /v1/themes/presets`; `GET/POST /v1/themes`; `GET/PATCH/DELETE /v1/themes/:id`; `POST /v1/themes/validate`; `POST .../:id/preview`, `/publish`, `/default`. Reads: account permission; writes: settings permission; dashboard publish/default require step-up.     |
| Assets / brand        | `GET/POST /v1/theme-assets`, `DELETE /v1/theme-assets/:id`; `POST /v1/themes/from-website`, `/v1/themes/from-store`. Upload via `api(..., {formData})` with `kind` and one `file`; browser sets the boundary.                                                          |

### Payment links and themes: preserve what already works

`deploy` already has `/dashboard/payment-links` and `/dashboard/payment-links/[id]`: fixed/open
amounts, edit, archive/restore, sharing/QR, totals, linked payment history and checkout overrides.
Use `PaymentLinkCreateSchema` / `PaymentLinkUpdateSchema`; bodies are strict. Preserve immutable
slugs, nullable clearing semantics, and unchanged expired timestamps when editing other fields.
`DELETE` archives; `PATCH {archived: false}` restores. List filters are `status`,
`include_archived`, `limit`, `starting_after`.

Use API `availability`, totals, `url` and `qr_url`. Availability can be `available`, `inactive`,
`archived`, `expired`, `used_up`, `merchant_not_ready`; open checkout reservations can consume
capacity before settlement. A payment link is reusable according to its limits, while each
checkout session and quote has its own expiry. Never reuse yesterday's deposit address as a
permanent payment address. `payment_link_id` filtering and payer-note/link fields already exist
in the redesigned payments UI/types; preserve them.

Use one idempotency key for retries of a supported create operation; generate a new one only for
a new logical operation. Do not apply that rule to API-key creation (below).

`deploy` already has `/dashboard/settings/themes` and `/dashboard/settings/themes/[id]`. Themes
and assets are store-wide. Saving a draft does not publish; publishing and selecting a default are
separate actions that affect live checkout appearance even while viewing Test. Render normalized
saved documents; map `THEME_INVALID.details.problems` to fields. Preserve existing blocks when
editing basic settings, and distinguish unpublished edits from the theme's published status.

Preview URLs expire after 15 minutes; use their returned URL and respect preview CSP. Preserve the
sealed payment block, real amounts/destination/QR and HTML/CSS validators. Asset URLs in this
deployment are served through `https://api.usetendr.tech/v1/assets`; GCS/public-bucket examples in
older handovers are historical. No storage credentials belong in browser code.

See [payment links](2026-10-30-payment-links.md) and [checkout themes](2026-10-30-checkout-themes.md)
for detailed schemas. Their deployment/readiness notes yield to this document and current code.

### Keys, webhooks and domains

API-key creation displays a server secret once; only a hash is stored. List metadata includes
prefix, scopes, creation, last use and revocation. Do not persist the raw secret in URLs, browser
storage, logs, fixtures or analytics. Clear it on dismissal, navigation and store/mode changes.
Use `ScopeValues`; default checkout permissions are deliberately narrower than all scopes.

Creation rejects `Idempotency-Key` so the secret cannot enter the replay cache. If its response is
lost, refresh metadata, revoke the unseen key and create a replacement. Revoke requires explicit
confirmation; subsequent authentication fails. Connected-site keys remain under Connected sites,
where disconnection also handles webhooks/domain ownership. The API-key page does not grant wallet
signing authority or bypass live/account readiness.

Webhook signing secrets are also displayed once on create/rotate. Distinguish a test delivery from
a real payment event. Checkout browser events are informational; fulfillment follows authoritative
backend settlement and signed webhooks.

Checkout domains are origins allowed to embed checkout, not branded checkout hosting. Require
HTTPS in production, no path or wildcard, up to 20 entries, shared across modes. Direct hosted
payment links do not require any entries. Notification-email changes remain pending until the
new address is verified; keep payment-email preferences separate from authentication emails.

## Error, money and interaction rules

| Condition                                                      | Required behavior                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `401 UNAUTHENTICATED`                                          | Let the shell redirect to sign-in with the return path.                                                                                   |
| `STEP_UP_REQUIRED`                                             | Use `withStepUp`; do not sign the person out.                                                                                             |
| Passkey cancellation/timeout                                   | Keep current state and offer retry; no success message.                                                                                   |
| `403 FORBIDDEN`                                                | Explain required role/owner; do not offer an API-key or different-store workaround.                                                       |
| `LIVE_MODE_UNAVAILABLE`                                        | Render backend availability. Local simulator intentionally has live writes off.                                                           |
| `ACCOUNT_NOT_READY` / provisioning                             | Show setup/resume based on account kind; native provisioning resumes activation.                                                          |
| `VALIDATION_ERROR`, `THEME_INVALID`, unsupported asset/address | Use `ApiError.details` and keep form input. Display exact backend constraint without substituting another asset.                          |
| Network error, rate limit, provider timeout                    | Distinguish safe reads, supported idempotent writes and pending signed payouts. Reload known resources before retrying uncertain actions. |
| Cross-store/mode `NOT_FOUND`                                   | Clear stale data and show unavailable; no fallback to another store.                                                                      |

`ApiError` exposes status, code, message, request ID and details. Show a support request ID where
useful; do not expose raw secrets or internal provider errors. Never treat missing balances as zero.

Token amounts are integer strings; order/fiat amounts are decimal strings. Use `parseUnits`,
`formatAmount`, `formatUsd`, `feeLines`, token decimals and supported explorer helpers. Avoid
floating-point money arithmetic and summing different assets. Unknown assets retain their full ID
and raw units. Distinguish quoted fees from recorded fees and a pending transfer from completion.

Payment states: `DETECTED`, `PROCESSING`, `SETTLED`, `PARTIALLY_REFUNDED`, `REFUNDING`, `REFUNDED`,
`HELD`, `SCREENING_PENDING`. Contract proposal states: `draft`, `pending`, `timelocked`, `executing`,
`executed`, `cancelled`, `expired`, `failed`. Native payout states are a separate set listed above.
Countdowns reaching zero do not prove execution.

Preserve the current monochrome dashboard in `dashboard.css` and its shared primitives; the old
indigo/cyan redesign brief is superseded by the implemented design. Scope styles away from
checkout. Keep full destinations available, mode/store visible, keyboard controls labeled and
mobile layouts usable. Every screen needs loading, empty, error, permission and pending states.

UI preview must remain visibly simulated and must not claim a real wallet balance, payment,
withdrawal or successful write. Do not silently enter preview after authentication/provider failure.
Private dashboard/API responses must not enter the service worker cache. Preserve nonce CSP,
self-hosted fonts, cookie/CSRF handling and the existing WebAuthn ceremonies.

## Development setup

Use Node 22+, npm 10+, Docker and Chrome/Chromium. Copy `.env.example` to `.env` only if missing;
use development-only values. Never borrow a production database or provider vault for fixtures.
The compose Postgres port is 15432; an older local container may use 5433—match the actual mapping.

### Work on the redesigned feature branch with a local backend

The following root `.env` overrides provide a local fake backend (other required defaults come
from `.env.example`). Keep `TEST_DATABASE_URL` separate: automated tests erase that database.

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:15432/tendr
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:15432/tendr_test
REDIS_URL=redis://localhost:6380/6
API_HOST=127.0.0.1
API_PORT=4000
API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
WEB_URL=http://localhost:3000
CHECKOUT_BASE_URL=http://localhost:3000
TENDR_CHECKOUT_BASE_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
WEBAUTHN_RP_ID=localhost
NEXT_PUBLIC_WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGINS=http://localhost:3000
MAIL_DRIVER=log
KEYVAULT_DRIVER=local
NEAR_CLIENT_DRIVER=fake
NEAR_FAKE_SIMULATE=1
MERCHANT_ACCOUNT_CODE_HASH_TEST=11111111111111111111111111111111
LIVE_ACCOUNT_DRIVER=native_intents
LIVE_MODE_ENABLED=false
GASLESS_LIVE_ENABLED=false
FEE_SWEEP_ENABLED=false
FX_PROVIDER=fixed
ASSET_STORE_DRIVER=memory
ASSET_PUBLIC_PROXY=true
TENDR_ASSET_ORIGIN=http://localhost:4000/v1/assets
WEB_INTERNAL_TOKEN=local-frontend-development-only-token
```

```bash
npm ci
docker compose -f infra/docker/docker-compose.yml up -d postgres redis
npm run build --workspace=@tendr/contracts
npm run db:generate
npm run db:migrate:dev --workspace=@tendr/api
npm run db:migrate:test --workspace=@tendr/api
# Terminal 1: API and fake-chain worker share one process.
npm run e2e:serve --workspace=@tendr/api
# Terminal 2, same checkout:
npm run dev:web
```

Open `http://localhost:3000/signup`. Local verification links appear in `apps/api/.mail/*.json`.
Use `localhost` consistently. `npm run dev` starts separate API/worker processes and therefore is
not the appropriate launcher for shared in-memory fake-chain state. The audited `deploy` helper
has no console checkpoint restoration; use disposable local fixtures after simulator restarts.
Memory assets are served through the local proxy and disappear on restart.

Live native writes are intentionally disabled in this local setup. Native component tests use
mocked responses, backend integration tests use fake provider/RPC responses, and funded live tests
use the separate setup below. Turning on the local live flag alone does not create a complete
native-mainnet simulator.

### Inspect the working console

In a separate checkout of `origin/test/api-console`, use `npm run dev:console`. It runs web 3300,
API 4300, isolated `tendr_api_console` database, Redis DB 8, local mail inbox and checkpointed fake
state. It removes production provider credentials and disables live money. Read `docs/api-console.md`
on that branch for setup, the 133-route workbench and database/state backup behavior.

### Local frontend with the live API

The console branch has `npm run dev:console:live`. It serves only the frontend at loopback port
3343 and opens a dedicated Chrome window at `https://app.usetendr.tech/dashboard`, with that host
mapped locally. API calls still reach Railway and move real funds when a person signs a live action.
This bypass applies only inside that Chrome profile; it does not change public DNS or fix the
public Vercel error. Reopen with `npm run dev:console:live -- --open`.

Configuration lives in ignored `.keyvault/live-console.json`; the deployment owner supplies it
privately. It contains web settings, including the server-only `WEB_INTERNAL_TOKEN`. Do not copy
wallet credentials, Railway tokens, database/provider secrets or another person's Chrome profile.
Each developer signs in using their own account and an appropriate store role.

These commands are not yet in `deploy`. To use this same harness for the redesigned feature branch,
port the launcher and its environment/Next-config support from console commit `98520e4`, preserving
the feature branch's design and existing config. Keep the loopback binding, exact certificate pin,
separate browser profile, isolated build directory, skip-dotenv behavior and production RP/origin.
It must not be turned into a public console deployment. Do not point a plain localhost frontend
at production: the deployed CORS, RP ID and cookies require the approved app origin.

## Verification and acceptance

This document was checked against both branch revisions, API routes/schemas and the live
configuration. API-key route/component/browser checks passed in the preceding implementation.
The merchant's receipt/withdrawal report is recorded above; no broader funded-flow certification
is implied. Public DNS restoration and the native UI merge remain incomplete.

From the feature branch, run checks for changed code:

```bash
npm run typecheck --workspace=@tendr/web
npm run lint --workspace=@tendr/web
npm run test --workspace=@tendr/web
npm run build --workspace=@tendr/web
npm run test:e2e --workspace=@tendr/web -- merchant-accounts.spec.ts
```

Add native component coverage when porting `NativeWallet.test.tsx`, plus regression coverage for
mode/store switching during pending requests. Existing useful tests include `lib/api.test.ts`,
`lib/payment-link-form.test.ts`, `lib/themes.test.ts` and `app/dashboard/api-keys/page.test.tsx` on
`deploy`. Use `checkout.spec.ts`, `payment-links.spec.ts`, `themes.spec.ts` for affected public flows.
The console's `npm run test:api-console --workspace=@tendr/web` uses its own launcher and covers
real local browser signup, links and API keys. Do not assume that command exists on `deploy`.

Standard Playwright uses an isolated test database, fake API/worker and virtual authenticator;
default web/API/store ports are 3100/4100/3200. Keep real credentials and funds out of these suites.
Disable trace/video/screenshots for tests displaying raw keys or sensitive signatures. Capture
review screenshots only after secrets are dismissed and with disposable test data.

| Acceptance case                             | Required result                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signup, login and session expiry            | Email/passkey flow works; user returns to intended route; step-up cancellation preserves state.                                                  |
| Native setup interrupted after registration | "Finish activation" resumes the existing wallet; no second registration or false active state.                                                   |
| Same authenticator / multiple stores        | Separate login and wallet credentials work on one device; stores receive distinct wallet keys/accounts.                                          |
| Native versus contract account              | Correct setup, withdrawal, settlement, approval and recovery controls; direct URLs respect capabilities.                                         |
| Wallet ownership and team roles             | Non-owner members can use allowed reads; cannot sign another person's wallet or gain control by changing role.                                   |
| Store/mode change during a request          | No old balances, drafts, secret keys, quotes or actions appear under the new selection.                                                          |
| Link settlement selection                   | Provider catalog, default/custom choice, null inheritance and historical session pinning all work; recipient remains the store wallet.           |
| Native withdrawal                           | Exact units and full recipient reviewed; signature only after explicit action; pending/expired/refunded/failed/completed states remain distinct. |
| Timeout after payout submission             | UI resumes the same payout; no replacement transfer or false cancellation.                                                                       |
| Refund approval                             | Proposal-derived payout uses server amount/destination; unsupported cases remain in review; contract and native ceremonies stay separate.        |
| API keys                                    | Owner/admin create with selected scopes, one-time copy, context reset, lost-response recovery and revoke are preserved.                          |
| Themes and settings                         | Shared scope is clear; drafts/publish/default are distinct; uploaded assets render; notification email remains pending until verified.           |
| Payments and money display                  | Backend totals and final statuses used; exact amounts, fees, token IDs and valid explorer links; missing data is not zero.                       |
| Public deployment                           | App DNS/HTTPS and RP/origin behavior work outside the local Chrome override before public acceptance.                                            |
| Accessibility / review                      | Mobile and keyboard flows work; screenshots show test data; PR lists checks run and any unresolved API dependency.                               |

Further references: [native wallets](2026-11-02-native-intents-wallets.md),
[payment links](2026-10-30-payment-links.md), [themes](2026-10-30-checkout-themes.md),
[deployment runbook](2026-10-31-deploy-runbook.md),
[Railway project](https://railway.com/project/a2f21ff5-5b3e-49f1-beb7-8990234aeca8).
Historical runbook readiness notes must be rechecked against the current status above.
