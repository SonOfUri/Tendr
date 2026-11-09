# Tendr dashboard frontend handover

Updated **9 November 2026** (AI, invoice and email-design review). Audience: the developer building the merchant dashboard in `apps/web`.
This is the current entry point for frontend work. It supersedes the deployment assumptions and
"missing screens" lists in earlier versions of this handover. The filename is retained for existing links.

## Start here

Start with the [AI, invoice and email delivery brief](2026-11-09-ai-invoices-email-design.md)
for screen states, design requirements, acceptance criteria and the full transactional email inventory.
The [offline email gallery](email-preview.html) shows synthetic examples of all 23 current templates.
The detailed API contracts remain below. AI and invoice backend code is present on both branches;
AI API integration into the product UI and designed HTML email delivery remain frontend/backend work.
Current emails are plain text.

The live backend supports native passkey wallets, payment links, incoming payments, withdrawals,
settlement selection and API-key management. **The merchant reports successfully receiving a live
payment through a payment link and withdrawing funds on 7 November.** Preserve those working
flows when integrating them into the redesigned dashboard.

There are two frontend implementations to reconcile:

| Branch / audited revision | What to use it for |
| --- | --- |
| `origin/deploy` at `24543c8` | Implementation baseline and Railway deployment branch: redesigned dashboard, native wallets/payouts, settlement selectors, API keys, AI APIs and invoice flow. Preserve its current design and payment behavior. |
| `origin/test/api-console` at `f1bb3dd` | Functional reference and isolated API workbench, including AI routes and itemized invoices. Use this for integration examples and local test scenarios. |

The revisions above identify code reviewed for this handover, not a requirement to reset a newer
checkout. Fetch before starting and review any subsequent changes. `main` is not the deployment baseline.

```bash
git fetch origin
git switch -c feat/dashboard origin/deploy
```

Keep the redesigned shell, existing editors and integrated native-wallet/settlement behavior from
`deploy`. Use console examples where useful, preserving the richer payment-link/theme editors and
production navigation. The earlier native-wallet porting checklist has been completed in this baseline.
Submit a PR against `deploy`; pushing directly to that branch can deploy immediately.

## Current live status and evidence

The configuration snapshot below was read from Railway on **7 November**; it is historical evidence,
not a fresh configuration audit. AI activation is recorded separately on 8 November. The public app
and invoice-host notes were checked on 9 November. No credentials are included here.

| Area                     | Current state and frontend implication                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live processing          | `LIVE_MODE_ENABLED=true`; new live accounts use `LIVE_ACCOUNT_DRIVER=native_intents`. Do not hard-code a "live disabled" banner. Read account/checklist responses.                                                                                                                                |
| Verification             | Merchant-reported live payment-link receipt and withdrawal succeeded. This establishes those exercised flows, not every chain, token, refund, wallet/browser or integration. No new money movement was performed for this documentation review.                                                   |
| Email                    | `MAIL_DRIVER=resend`; the merchant fixed domain DNS and reported signup mail arriving. Resend verification is no longer an outstanding setup blocker.                                                                                                                                             |
| Screening                | `SCREENING_MODE=disabled`, an operator-selected hackathon configuration. Live funds are **not sanctions-screened**. Do not label skipped screening as a passed check; existing held payments remain held.                                                                                         |
| Gas sponsorship / sweeps | `GASLESS_LIVE_ENABLED=false`, `FEE_SWEEP_ENABLED=false`. Do not promise active gasless sponsorship or automatic sweeps from a saved preference alone.                                                                                                                                             |
| API / checkout           | `https://api.usetendr.tech` and `https://pay.usetendr.tech`. API readiness and the new authenticated API-key route were checked on 7 November. Shopper links stay on the pay host.                                                                                                                |
| Public dashboard         | Configured origin is `https://app.usetendr.tech`, RP ID `usetendr.tech`. The public app host now serves the Railway frontend; the earlier Vercel failure is resolved. The separate `invoice.usetendr.tech` host still needs DNS/hosting correction; use the app-host invoice fallback.                                    |
| Working live console     | A dedicated Chrome profile maps the app origin to a loopback frontend while calling the real API. This is how the functional console is used; it does not establish that the public app domain works. See development setup below.                                                                |
| Infrastructure           | HODL workspace, Railway `tendr` project; API, worker, web, Postgres, Redis. API/worker use `KEYVAULT_DRIVER=env`; assets use `ASSET_STORE_DRIVER=s3` with API-served assets. Native wallet onboarding does not require GCP billing, funding `tendr.near`, or deploying a per-store NEAR contract. |

A missing frontend feature must not be presented as a disabled backend capability. Conversely,
a successful deployment or a UI preview is not evidence that a payment executed.

## Delivery checklist: what actually needs work

| Priority | Work | Existing code / completion requirement |
| --- | --- | --- |
| 1 | Integrate the four AI surfaces | Wire checkout help, route comparison, merchant insights and theme generation to their existing APIs. Follow the new brief's loading/error/context and explicit-publish rules; demo responses are not the integration. |
| 1 | Refine the invoice experience | Public submission/verification, itemized totals and owner inbox/payment already work. Deliver complete mobile, empty, expired, non-owner, processing and payment-review states while preserving exact amount and passkey behavior. |
| 1 | Design transactional emails and integrate rendering | Cover all 23 template keys and invoice outcome variants. Resend currently receives plain text; HTML needs renderer/provider changes and richer structured invoice data if the design includes item tables. Use the fixture gallery and brief. |
| 2 | Preserve wallet and payment flows | Native onboarding, payout/withdrawal, capability guards, refund approval and per-link settlement are already integrated on `deploy`. Regression-check store/mode changes, owner checks, signing cancellation and pending outcomes. |
| 2 | Finish presentation and regression coverage | Preserve API-key one-time secrets, permissions and context isolation. Exercise payments, webhooks, settings and team flows against real response shapes. |
| 2 | Extend themes where required | Existing presets, brand import, logo upload, CSS, validation, preview and publish/default remain the baseline. Review advanced block/font editing against current code before estimating additional work. |
| Operator | Finish the custom invoice host | Verify Railway's requested DNS records for `invoice.usetendr.tech`; keep `https://app.usetendr.tech/invoice/<slug>` available. Preserve the established dashboard RP ID and CORS. |

Use existing backend contracts for analytics and overview metrics; the AI insight report is a
bounded cohort report, not an arbitrary time series. Before adding global search, export or a new
refund flow, locate the matching current route or agree on its contract. Do not invent figures
from a single page of records. Integration-specific setup remains in the
[Shopify pilot guide on `test/api-console`](https://github.com/SonOfUri/Tendr/blob/test/api-console/docs/shopify-connector.md)
and [WooCommerce specification](../superpowers/specs/2026-10-26-woocommerce-plugin-design.md).
The Shopify pilot guide/code is not part of the audited `deploy` baseline. Earlier pilot/release
observations are not current release guarantees.

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
| `apps/web/src/lib/payment-link-types.ts`, `payment-link-form.ts`          | Redesigned link DTO/form logic on `deploy`, including default/custom settlement fields.                                                                                                                                     |
| `apps/web/src/lib/themes.ts`                                              | Theme draft state, validation mapping and editor helpers on `deploy`.                                                                                                                                          |
| `apps/web/src/components/dashboard/ui.tsx`, `Select.tsx`, `dashboard.css` | Redesigned dashboard primitives and responsive monochrome styling on `deploy`; use these with shared `packages/ui`.                                                                                            |
| `apps/web/src/app/dashboard/api-keys/`                                    | Working create/list/revoke page and component tests on both branches.                                                                                                                                          |

Native functional references originated on `test/api-console` (principally `85ccc73`) and are now
integrated into `deploy`; use its current versions:

- `apps/web/src/components/dashboard/NativeWallet.tsx` and `NativeWallet.test.tsx`.
- `apps/web/src/lib/native-wallet.ts`: `registerWallet`, `activateWallet`, `signPayout`.
- `apps/web/src/app/dashboard/wallet/page.tsx`.
- Native branches in account home, `withdraw/page.tsx`, `settings/payout/page.tsx`,
  `approvals/page.tsx`, `approvals/[id]/page.tsx`, and the shell capability guard.
- `apps/web/src/app/dashboard/payment-links/SettlementSelector.tsx`, `PaymentLinkForm.tsx`,
  and `apps/web/src/lib/dashboard-payment-links.ts` for per-link settlement behavior.
- `docs/api-console.md` and the console launchers are available on both audited branches.

The backend same-authenticator registration fix is already on both branches (`4b6e431` on console,
`acac4fa` on deploy). A wallet credential may be created on the same device/authenticator that
holds a login credential; they must still be distinct credentials and keys.

## Session, context and permissions

### Email sign-in fallback (9 November 2026)

`/login` offers both a login passkey and an email link. `POST /v1/auth/email/start` accepts
`{email,next?}`; email is trimmed/lower-cased and `next` is an optional same-site path (max 2,048
characters). Both new and existing people receive the same 202 `{ok:true}` response. A verified
existing person receives `login_link` even when they already have active login passkeys. New or
unverified people receive `verify_email`. Links remain one-use with a 15-minute lifetime.

`POST /v1/auth/email/verify` with `{token}` returns the existing user ID, `hasPasskey`, CSRF token
and session cookies. The unique normalized email lookup prevents a second account from being
created for a returning person. Email verification creates a session with **no passkey step-up**.
It does not replace login keys, create a new business/wallet or revoke the person's other sessions.

The verification page waits for an explicit click, removes the token/return path from the address
bar, and skips registration for `hasPasskey:true`. New people still complete their first login
passkey setup. Same-site `next` travels in the emailed URL, preserving store/mode deep links even
in another tab/device; external URLs and browser-normalized redirect tricks are rejected/ignored.
Connect and pending-invite routing keep their existing precedence.

Native wallet signing remains separate. Existing sensitive-action checks are unchanged: adding or
revoking login keys, team changes and native payout routes still require login-passkey step-up;
submitting a native transfer also requires its wallet-passkey signature. Email access alone cannot
recover a lost wallet key or authorize spending. Do not describe an email session as fully stepped up.
The selected business/mode remains a per-tab preference; a fresh browser starts in Test mode.

Regression coverage: magic-link identity, expiry/replay, return URLs, returning-user verification,
new-person setup, two sessions reading the same live wallet, and rejection of protected writes.

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

Reuse the integrated `registerWallet`/`activateWallet` helpers. The activation helper requests
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
not the appropriate launcher for shared in-memory fake-chain state. This `e2e:serve` setup
has no console checkpoint restoration; use disposable local fixtures after simulator restarts.
Memory assets are served through the local proxy and disappear on restart.

Live native writes are intentionally disabled in this local setup. Native component tests use
mocked responses, backend integration tests use fake provider/RPC responses, and funded live tests
use the separate setup below. Turning on the local live flag alone does not create a complete
native-mainnet simulator.

### Inspect the working console

Use `npm run dev:console` on either audited branch; keep separate checkouts when comparing the two frontends. It runs web 3300,
API 4300, isolated `tendr_api_console` database, Redis DB 8, local mail inbox and checkpointed fake
state. It removes production provider credentials and disables live money. Read `docs/api-console.md`
for setup, the generated API workbench and database/state backup behavior. Regenerate its catalog
after route changes; older route counts in setup notes are not a coverage guarantee.

### Local frontend with the live API

Both audited branches have `npm run dev:console:live`. It serves only the frontend at loopback port
3343 and opens a dedicated Chrome window at `https://app.usetendr.tech/dashboard`, with that host
mapped locally. API calls still reach Railway and move real funds when a person signs a live action.
This mapping applies only inside that Chrome profile; it does not change public DNS. Reopen with `npm run dev:console:live -- --open`.

Configuration lives in ignored `.keyvault/live-console.json`; the deployment owner supplies it
privately. It contains web settings, including the server-only `WEB_INTERNAL_TOKEN`. Do not copy
wallet credentials, Railway tokens, database/provider secrets or another person's Chrome profile.
Each developer signs in using their own account and an appropriate store role.

Use the existing launcher and Next configuration on your feature branch. Keep the loopback binding, exact certificate pin,
separate browser profile, isolated build directory, skip-dotenv behavior and production RP/origin.
It must not be turned into a public console deployment. Do not point a plain localhost frontend
at production: the deployed CORS, RP ID and cookies require the approved app origin.

## Verification and acceptance

This documentation review checked both branch revisions and the AI, invoice and mail routes/schemas.
The earlier live configuration observations and merchant receipt/withdrawal report are dated above.
This review did not send mail, invoke a production model or move funds. The native UI merge is present
in the current baseline; the custom invoice host remains an operator item.

From the feature branch, run checks for changed code:

```bash
npm run typecheck --workspace=@tendr/web
npm run lint --workspace=@tendr/web
npm run test --workspace=@tendr/web
npm run build --workspace=@tendr/web
npm run test:e2e --workspace=@tendr/web -- merchant-accounts.spec.ts
```

Maintain the existing native component coverage and add regression coverage for
mode/store switching during pending requests. Existing useful tests include `lib/api.test.ts`,
`lib/payment-link-form.test.ts`, `lib/themes.test.ts` and `app/dashboard/api-keys/page.test.tsx` on
`deploy`. Use `checkout.spec.ts`, `payment-links.spec.ts`, `themes.spec.ts` for affected public flows.
The console's `npm run test:api-console --workspace=@tendr/web` uses its own launcher and covers
real local browser signup, links and API keys; it is also present on the audited `deploy` revision.

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

## AI APIs

Implemented on both audited branches; originated on `test/api-console` on 7 November 2026.
Use the [AI delivery brief](2026-11-09-ai-invoices-email-design.md#ai-screens-states-and-interactions)
for product interactions and acceptance criteria. This covers checkout assistance, quote previews,
merchant insights and theme drafts; risk detection and agent/MCP payments remain separate work.
**Production activation — 8 November 2026:** the Railway API in the HODL workspace now uses
NEAR AI Cloud with `z-ai/glm-5.3-flash`. Backend deployment commit: `f30fe51` on `deploy`.
The saved key is configured as the API service's server-only `NEARAI_API_KEY`. The three
synthetic checks (checkout assistant, merchant insights, full theme validation) passed from
inside the production API container; the public health check returned 200 and unauthenticated
AI requests returned 401 with `Cache-Control: no-store`. The check created no orders, payments
or saved themes. API, worker and web deployed successfully. These are operational smoke checks,
not a broad model-quality evaluation. Attestation verification and E2EE remain unimplemented.

The two checkout routes use the current checkout's
`Authorization: Bearer <client_secret>` and return `Cache-Control: no-store`. Dashboard cookies,
merchant API keys and client-supplied session/account IDs cannot substitute for that credential.
Types and request schemas are exported from `@tendr/contracts` (`src/ai.ts`). The API console's
**checkout ai** group contains both routes and sample bodies. No new dashboard UI is required to
exercise them. The demo ghost still uses its original static ranking until the FE integrates these APIs.

### Payment assistant

`POST /v1/checkout/client/ai/assistant`

```json
{ "question": "Has my payment completed? What happens next?" }
```

The question is required, trimmed, at most 1,000 characters; no conversation history is accepted.
The result contains `answer` (plain text), `facts: [{ id, text }]`, `generated_at`,
`source: "model_selected_facts"`, and `read_only: true`. Render the answer as text, never HTML.
The model chooses relevant facts about this session's status, refunds, underpayment, fee policy,
networks and privacy. Server-written facts form the final answer; arbitrary generated financial
claims or transfer instructions are not displayed. Status/refunds are re-read after model latency.
Test-mode answers identify themselves. This answer never authorizes fulfillment; keep the existing
verified settlement/webhook flow.

The model receives no database access, signing tools, credentials, merchant/account/session IDs,
emails, transaction hashes, refund destinations, order metadata, branding or product descriptions
from Tendr's records. Common identifiers in the free-text question are redacted, but this is not a
general PII detector: tell shoppers not to enter personal information, keys or seed phrases. The
configured model provider processes the redacted question and supplied facts under its own data
policy. Tendr does not persist chat transcripts or provider responses. The generic adapter sends
`store: false`; the NEAR adapter uses its documented Chat Completions fields.

Server configuration for NEAR AI Cloud (added 8 November 2026):

```dotenv
AI_PROVIDER=near-ai
AI_BASE_URL=https://cloud-api.near.ai/v1
AI_MODEL=z-ai/glm-5.3-flash
AI_TIMEOUT_MS=20000
AI_DAILY_REQUEST_LIMIT=200
```

Set `NEARAI_API_KEY` as a server-only Railway secret or in the ignored root `.env` for local
use. Alternatively, store it encrypted under KeyVault purpose `near-ai` with `secrets:put`.
An encrypted key takes precedence over the environment. The NEAR adapter does not reuse
`AI_API_KEY` or a generic `ai-provider` secret. Never put credentials in `NEXT_PUBLIC_*`.
The NEAR base URL is selected automatically when omitted; a different gateway is rejected
in `near-ai` mode to prevent sending this credential to another provider.

Supported profiles are `z-ai/glm-5.3-flash` (minimal reasoning with a 32-token thinking cap)
and `Qwen/Qwen3.6-35B-A3B-FP8` (thinking disabled). NEAR requests use `max_tokens` and JSON mode.
There is no automatic model/provider fallback. Unknown profiles fail configuration validation.
The model catalog and reasoning behavior were checked against
[NEAR's reasoning documentation](https://docs.near.ai/cloud/reasoning-models).

This integration uses HTTPS to NEAR AI Cloud. The selected models are listed by NEAR as Private
TEE models, but **Tendr does not yet independently verify attestations or response signatures,
and does not enable client-to-model E2EE**. Do not show a verified-private badge. NEAR's current
[verification SDK](https://docs.near.ai/cloud/inference-sdk/javascript) requires Node 24.22.1+;
Tendr's API currently runs Node 22. Inference privacy does not make blockchain payments confidential.

After configuring the key, run `npm run ai:verify --workspace=@tendr/api`. This operator-only
command makes three billable model requests with synthetic facts/design text, validates assistant
and insight selections plus the full generated theme document, and prints no credentials or raw
model output. It does not create payment, theme or chat records. It exits nonzero on a failed check;
`provider_status` identifies upstream HTTP failures without leaking their response bodies.
This explicit operator check is separate from the public API's Redis usage reservations.

Model calls still default to `AI_PROVIDER=disabled`. `npm run dev:console` deliberately disables
model calls and strips AI credentials, just like other real-provider secrets. Use the regular API
with the root `.env`, or the live console after the Railway API has been deployed and configured.

The generic adapter remains available with `AI_PROVIDER=openai-compatible`, `AI_API_KEY` (or
KeyVault purpose `ai-provider`), an explicit model, and `AI_BASE_URL` (defaults to
`https://api.openai.com/v1`). It requires Chat Completions JSON mode, `max_completion_tokens`
and `store: false`. These settings are independent of the NEAR profile.

The assistant permits six requests per session/minute. All model features share 30 calls per
merchant/minute and the configured platform maximum per UTC day across live/test. Each assistant
or insight-summary request permits one model call and up to 300 completion tokens; a theme draft
permits one call with up to 2,000 completion tokens. Failures consume the reservation too. This is a request cap, not a
dollar budget; configure the provider's own spend controls. Redis failure blocks model calls.
`503 PROVIDER_NOT_CONFIGURED` means disabled/missing configuration; `503 PROVIDER_UNAVAILABLE`
means provider/usage-control failure or invalid output; `429 RATE_LIMITED` means a limit was hit.
Keep payment controls working when assistance is unavailable. Do not auto-retry in a loop.

### Route recommendations

`POST /v1/checkout/client/ai/recommendations`

```json
{
  "assets": [
    { "asset_id": "nep141:usdc.test", "balance": "50000000" },
    { "asset_id": "nep141:eth.test" }
  ]
}
```

Use the current mode's `/v1/checkout/client/tokens` catalog, not these test fixture IDs for live
requests. Supply one to four distinct assets. Optional `balance` is a wallet-reported integer in
base units; the API does not independently verify it. Insufficient balances are excluded. Missing
balances remain eligible with `balance_sufficient: null`; a sufficient token balance does not
guarantee enough native gas.

`routes` contains asset, symbol, chain, input base units, input USD, output base units, provider ETA
in seconds (or null), and the balance check. `recommended`, `cheapest`, and `fastest` are asset IDs
or null. Cheapest/recommended minimize provider-quoted input USD among successful eligible
candidates; ties prefer known shorter ETA. Fastest compares only candidates with a provider ETA.
There are no hard-coded fee/speed claims or model-generated prices. `unavailable` lists unsupported,
insufficient-balance and quote-unavailable candidates; partial success is normal.

These estimates **exclude the shopper's origin-chain gas** and do not promise the lowest total
cost. Merchant gas sponsorship/deductions and the actual wallet/refund route are resolved when
the executable quote is created. The response explicitly sets
`ranking_basis: "quoted_input_usd_excluding_wallet_gas"`, `wallet_gas_included: false`, and
`requires_fresh_quote: true`. Show these limits next to the comparison.

Previews expire after at most 30 seconds or checkout expiry. `source` distinguishes `live_quotes`
from `simulated_quotes`; test data never masquerades as live. Every provider request is `dry:true`:
no deposit address is allocated, no active quote is replaced, and no payment/refund is created.
Only after the shopper selects a route should the existing `/quote` endpoint run with the actual
wallet/refund options. Only that response supplies instructions for sending money.
Expired, settled or in-flight checkouts reject previews with 409. Limits are three previews per
session/minute, 30 per merchant/minute and 120 across the platform/minute; each compares at most
four assets with two dry provider calls each. Preview ranking needs no LLM credential.

### Merchant insights

`GET /v1/ai/insights?days=30` returns calculated metrics without an LLM credential.
`POST /v1/ai/insights` accepts `{ "days": 30, "question": "Where are checkout drop-offs?" }`
and adds a model-selected explanation. Days must be an integer from 1 to 90; omitted means 30.
The question is optional (a summary is the default) and limited to 1,000 characters.

Both routes require a dashboard session with `account:read` and the store/mode headers. POST also
requires CSRF. API keys and checkout session secrets cannot access merchant analytics. Results are
scoped to the selected merchant and mode, with `Cache-Control: no-store`.

The report compares sessions **created** in the last N days with those created in the preceding N
days. Each cohort reports sessions created, quoted, with a recorded deposit, settled, expired without
a deposit, and with a refund record. Multiple quotes/deposits/refunds on one session count once.
Payment/refund states are current, so an older cohort has had longer to mature: do not present the
comparison as a controlled experiment. These are session counts, not unique visitors or page views.

Conversion is settled sessions / created sessions, returned as a two-decimal percentage string.
An empty cohort returns null conversion, and either empty cohort makes the comparison null.
Automatic refunds of deposits that never settled do not count as conversion. Settled orders that
were subsequently refunded retain their settlement history; refund records are reported separately.
`settled_order_totals` contains exact decimal strings grouped by currency. These are order totals,
not net received amounts or balances; fees/refunds are not subtracted and currencies are never summed.
Expired-without-deposit counts show a stage, not a proven cause of abandonment.

GET returns `MerchantInsights` from `@tendr/contracts`: `window`, `current`, `previous`,
`conversion_change_percentage_points`, `facts`, `generated_at`, `source` and `livemode`.
POST returns `{ report, answer, facts, source: "model_selected_facts", read_only: true }`.
Render the answer as plain text. Only calculated facts reach the model; raw shopper, wallet,
merchant identity and order records do not. The selected facts refer to the attached report, which
is not recomputed during the model call. Six summaries per dashboard member/minute are allowed,
within the shared model budget above. GET uses normal dashboard rate limits.

### AI theme drafts

`POST /v1/ai/themes` requires a dashboard session with `settings:manage`, CSRF and an
`Idempotency-Key`. Reuse the same key for a retry of the same generation request.

```json
{
  "name": "Midnight draft",
  "prompt": "A dark checkout with violet accents, rounded corners and clear typography."
}
```

The name is required and at most 80 characters; the design prompt is required and at most 2,000.
The model proposes palettes, curated fonts, corners, celebration, layout and optional CSS. Its
layout vocabulary is header, order summary, payment, divider and spacer; it must keep exactly one
header, order summary and payment block. Existing success-page blocks are retained. This version
does not generate logos/images, HTML, external links, testimonials or merchant copy. The store's
actual display name is inserted by the server and is never sent to or replaced by the model.

All proposals pass the existing document, contrast and CSS validators before saving. CSS stays
scoped to merchant content and cannot cover payment controls; generated URLs/imports are rejected.
Invalid generation creates no theme. Creation also rechecks the 20-theme limit under a merchant
row lock, shared with normal theme creation, so concurrent generation cannot bypass it.

A successful response is 201 with `{ theme, source: "model_generated_draft", requires_publish: true }`.
`theme` is the existing `ThemeObject`, unpublished and not default. Existing drafts and published
themes are untouched. Open the ordinary editor/preview on this new theme, then use the existing
explicit publish/default actions and their permissions/step-up checks after merchant review.
Generation never publishes. Test/live share the same theme library, as before.

Three generations per dashboard member/minute are allowed, within the shared model budget.
Provider errors return 503; rejected presentation returns `THEME_INVALID` (400); a full library
returns `THEME_LIMIT` (409). Preserve valid existing themes when generation fails. The model
receives only the redacted design brief and the curated font IDs; prompts are not stored as chat
history. The new endpoint and example are in the console's **merchant ai** group.

### Remaining AI work

AI risk/brand-impersonation detection, registered-agent budgets/allowlists/approval thresholds
and MCP are still planned. Paid-plan entitlements and
production model-quality evaluation are also outstanding. This slice introduces no automated
payment authority and makes no changes to the existing screening policy.

## Contractor invoices (9 November 2026)

Use the [invoice delivery brief](2026-11-09-ai-invoices-email-design.md#invoices-contractor-and-merchant-journeys)
for screen states, complete contractor/owner journeys and the design acceptance matrix.

This is an **accounts-payable** flow: a contractor invoices a Tendr business, and the business pays from its existing live native wallet to the contractor's external wallet. It is separate from customer checkout/payment links. The owner enables the page in **Dashboard → Invoices**. `INVOICE_BASE_URL=https://invoice.usetendr.tech` produces `/<merchant slug>`; without this setting, local development uses `WEB_URL/invoice/<slug>`. The slug is the existing business slug.

Contractors need no Tendr login. They enter their name, email, invoice reference, optional due date, receiving network/token, wallet and a payment breakdown. Each line has a description and decimal token amount; the displayed total is calculated automatically. The public API sends a private verification link on the existing app host (`WEB_URL/invoice/<slug>`) with a random token in its URL fragment. The established app host also provides a working fallback entry page while the invoice subdomain awaits DNS; email verification never depends on the optional subdomain. Reading the link does not submit the invoice: the contractor must review the immutable terms and press **Verify email & send invoice**. Verification expires after 24 hours. Only the token hash is stored. Keep tokens out of URLs sent to the API, analytics, logs and persisted browser storage. Verified invoices become visible in the business inbox. The owner gets an email notice; paid/declined notices go to the verified contractor email.

Public routes use no cookies, no Tendr account headers, and no credentials. All responses are `no-store`:

| Method and path                             | Input / response                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/invoices/public/:business`         | Business name/slug and current supported tokens (`assetId`, `blockchain`, `symbol`, `decimals`). 404 while paused/unavailable. Never exposes invoices or balances.                                                                                  |
| `POST /v1/invoices/public/:business`        | Strict JSON: `contractorName`, `email`, `reference`, optional `dueDate` (`YYYY-MM-DD`), `destinationAsset`, `destination`, `items` (1–50 objects with `description` up to 200 characters and `amount` in decimal **token units**, string). Do not send a separate total. Returns 202 `{accepted:true}` without an invoice ID or token. |
| `POST /v1/invoices/public/:business/status` | `{token}` from email; returns that one invoice.                                                                                                                                                                                                     |
| `POST /v1/invoices/public/:business/verify` | `{token}`; publishes the invoice after email verification. Idempotent after verification.                                                                                                                                                           |

The API validates every line against the selected token’s precision and calculates the total with integer arithmetic. Zero/negative amounts, excess precision, overflow and requests mixing `items` with a top-level `amount`/`description` are rejected. Invoice **responses** include `items: [{description, amount}]`; both item amounts and the invoice total are integer base-unit strings with explicit `symbol`/`decimals`. Do not use JavaScript floating point. The original `{description, amount}` submission shape remains accepted for older clients; historical invoices without stored items are returned as one line using their original description and amount. Show the same breakdown during email verification and merchant review. Invoice totals are denominated in the receiving token, not a fiat FX estimate. Only external chains supported by the destination validator are listed (EVM, NEAR, Solana, Bitcoin and Tron families); memo/tag destinations are not supported. Reference is unique per normalized contractor email, business and mode. Repeating an unverified reference resends verification for the **original** details and invalidates its previous link. Once verified, use the original private email link; repeating the submission does not create another invoice. To correct terms, the business declines the old invoice and the contractor submits a new reference.

Dashboard routes require the usual cookie session, merchant/mode headers, CSRF for writes and `Idempotency-Key` on POSTs. Reads require `account:read`; mutations require `security:propose`, step-up, and the actual native wallet owner. Invoicing/payment is live-only; the test dashboard displays an explanation.

| Method and path                | Purpose                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/invoices/settings`    | `{enabled,url}`                                                                                                                                                                                   |
| `PUT /v1/invoices/settings`    | `{enabled:boolean}`; active native wallet required. Pausing stops new submissions/verification, not existing payments/status reads.                                                               |
| `GET /v1/invoices?cursor=...`  | `{invoices,nextCursor}`; 50 newest verified invoices per page.                                                                                                                                    |
| `GET /v1/invoices/:id`         | Invoice details, latest payout and its provider receipt.                                                                                                                                          |
| `POST /v1/invoices/:id/reject` | Declines an unpaid invoice and invalidates any unsigned quote.                                                                                                                                    |
| `POST /v1/invoices/:id/payout` | `{asset}`: choose a source token from the merchant's wallet balances. Destination and amount are taken from the immutable invoice, never the request. Returns a native payout, **not a payment**. |

Payment flow: create the invoice payout, display its debit (`asset`, `amount`), invoice receiving amount/token/chain and full destination, then use `signPayout(context,payout)` from `src/lib/native-wallet.ts`. This calls the existing `/v1/account/native/payouts/:id/challenge` and `/submit` routes. Login step-up and the wallet passkey are separate. The backend uses 1Click `EXACT_OUTPUT`: the quote fixes the receiving amount and includes the input required for fees/slippage. No invoice fees are added by Tendr in this release. See the [provider's swap-type semantics](https://docs.agentsonintents.com/integration/distribution-channels/1click-api/swap-types). Never show a submitted signature as paid.

Invoice states:

- `awaiting_verification`: private draft, absent from the merchant inbox.
- `open`: awaiting owner approval; an unsigned quote may exist. Failed/refunded payouts return here only after reconciliation permits a retry.
- `processing`: signature durably saved; awaiting provider confirmation. Disable rejection and additional payment attempts.
- `paid`: provider SUCCESS, destination transaction present, and delivered amount covers the invoice.
- `payment_review`: provider SUCCESS receipt is missing/short on the delivered amount. Do not retry or mark paid; operator review is required.
- `rejected`: terminal; cannot pay.

Quote requests racing for the same invoice reuse one active payout. An expired unsigned quote is invalidated before replacement; rejected invoices invalidate their unsigned quotes. Signed unknown outcomes reuse the identical signed intent, never a new nonce. A partial unique DB index forbids simultaneous active/successful attempts. Money, screening, key ownership and passkey checks remain those of native withdrawals. Successful payment receipts expose real destination transaction hashes. Invoices do not make blockchain transfers private.

Deployment: apply migrations `20261109120000_invoices` and `20261109150000_invoice_items` before starting the updated API/worker. Configure `INVOICE_BASE_URL` on API, worker and web (including web build). Attach `invoice.usetendr.tech` to Railway's existing **web** service and publish Railway's requested DNS records. The invoice origin and existing app origin (for the `/invoice/<slug>` fallback) are allowed on public invoice APIs without cookies; never add it to dashboard CORS. Do not change WebAuthn origins for this subdomain: contractors do not sign, and owners sign on the existing dashboard. Existing businesses remain opted out until their wallet owner enables the page. PDF export, attachments, automatic tax calculations, recurring invoices, partial payment and batch payment are outside this first release.

## Transactional email design (9 November 2026)

The [email delivery contract](2026-11-09-ai-invoices-email-design.md#email-design-and-delivery-contract)
contains all 23 template keys, actual triggers/recipients, data fields, links, expiry rules and the
four invoice-notice outcomes. Use the [offline preview gallery](email-preview.html) and
[synthetic fixtures](email-design-fixtures.json) for design work without real email or credentials.

Production currently sends **subject + plain text only**. Designed HTML needs a server renderer
and `ResendMailer` integration with a text alternative. Several handlers supply their own copy,
and invoice notices currently supply `data: {}` plus subject/text; richer invoice summaries need
structured backend fields. The brief distinguishes this implementation work from what exists today.
