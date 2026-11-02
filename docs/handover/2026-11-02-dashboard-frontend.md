# Tendr dashboard frontend handover

Updated 2 November 2026. For the frontend developer building the merchant dashboard in `apps/web`.

The dashboard already has account onboarding, payments, approvals, withdrawals, team management, and security flows connected to the API. Build on those flows, improve their presentation, and add the missing payment-link and checkout-theme management screens. Preserve passkey signing, merchant isolation, and the distinction between test and live money throughout the work.

**Test branch update:** `test/api-console` now includes a basic `/dashboard/payment-links` screen and navigation: create fixed/open amounts, edit/pause, expiry/use limits, share URL/QR, archive/restore, and store/mode isolation. Its form is in `apps/web/src/app/dashboard/payment-links/PaymentLinkForm.tsx`; payload validation and response types are in `apps/web/src/lib/dashboard-payment-links.ts`. Reuse this work when building the full dashboard. Checkout overrides, totals, and link-filtered payment history remain follow-up work. The deployment baseline described below has not changed.

The test branch also supports a per-link settlement asset: choose a source chain and token from
the mode's provider catalog, or inherit the store default. Funds stay in the merchant's Tendr
Intents account. The implementation and migration are described in the
[payment-link handover](2026-10-30-payment-links.md); preserve its session pinning and recipient
rules when redesigning this selector. Fee/gas/theme overrides remain separate follow-up work.

## Starting point and deployment

Use **`origin/deploy`**, baseline commit **`37617ac`**, for the implementation. `main` does not yet include all deployment changes, including host routing and the live-mode availability checklist. Create a feature branch from `deploy` and submit the dashboard work for review against that branch. Railway builds from `deploy`, so a push there can deploy immediately.

```bash
git fetch origin
git switch -c feat/dashboard origin/deploy
```

Deployment status at handover:

| Item                     | Status and frontend impact                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Railway                  | HODL workspace, `tendr` project, production environment. API, worker, web, Postgres, and Redis reported successful deployments on 2 November.                                  |
| Dashboard origin         | Configured as `https://app.usetendr.tech`; custom-domain DNS and HTTPS still need verification before using it for browser acceptance tests.                                   |
| Checkout and API origins | Configured as `https://pay.usetendr.tech` and `https://api.usetendr.tech`. Keep merchant navigation on the app host and shopper navigation on the pay host.                    |
| Provider configuration   | Resend, 1Click, Open Exchange Rates, and Reown values have been copied into Railway. This is configuration confirmation, not an end-to-end provider test.                      |
| Outstanding backend work | Chainalysis key; NEAR parent-account access and funding; contract publication and fee accounts; Resend domain verification; end-to-end payment verification.                   |
| Live money               | `LIVE_MODE_ENABLED=false`, `GASLESS_LIVE_ENABLED=false`, and `FEE_SWEEP_ENABLED=false`. A successful deployment does not mean live payment processing is enabled.              |
| Keys and assets          | The deployed API and worker use an environment-backed software vault. Assets use a private Railway bucket served through the API. GCP billing is not needed for frontend work. |

Production requires real NEAR RPC even for testnet account provisioning. Until the testnet setup is complete, deployed signup can reach an account-setup failure. Use the local fake NEAR environment below for dashboard development; do not hide a provisioning failure behind a successful UI state.

## Code map

All code paths below are relative to the repository root on `deploy`.

| Path                                                   | Responsibility                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/app/dashboard/`                          | Next.js App Router merchant pages.                                                                                                 |
| `apps/web/src/components/dashboard/DashboardShell.tsx` | Session boot, store selection, test/live selection, navigation, passkey gate, recovery banner, sign-out. Exposes `useDashboard()`. |
| `apps/web/src/components/dashboard/common.tsx`         | `useLoad`, `useAction`, status rendering, destination display, countdown updates.                                                  |
| `apps/web/src/lib/api.ts`                              | Cookie-authenticated dashboard requests, CSRF, merchant/mode headers, typed errors, account/team/proposal types.                   |
| `apps/web/src/lib/webauthn.ts`                         | Passkey registration, login, step-up, and challenge signing.                                                                       |
| `apps/web/src/lib/proposals.ts` and `actions.ts`       | Proposal creation, approval/cancellation, action summaries and destination rules.                                                  |
| `apps/web/src/lib/payments.ts` and `assets.ts`         | Payment/refund types, exact amount formatting, token metadata, transaction links.                                                  |
| `apps/web/src/components/dashboard/PayoutChooser.tsx`  | Settlement selection and signer approval.                                                                                          |
| `packages/contracts/src/`                              | Shared Zod schemas, roles, permissions, state enums, themes, payment links.                                                        |
| `packages/ui/src/`                                     | Shared `Button`, `Alert`, `Spinner`, `StatusBadge`, and design tokens.                                                             |
| `apps/web/src/app/globals.css`                         | Existing application and dashboard styles. There is no dashboard component framework to replace.                                   |
| `apps/api/src/routes/`                                 | Authoritative route methods and authentication requirements. Business logic sits in adjacent feature directories.                  |

Stack: Next.js 15, React 19, TypeScript, npm workspaces and Turborepo; Vitest and Playwright for tests. The existing dashboard uses client components and direct calls through `api()`, rather than a query-cache library.

## Existing screens

These routes exist and call the API. Treat them as the functional baseline for a redesign.

| Route                                                  | Current behavior                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/signup`, `/verify`, `/login`                         | Email verification and passkey signup/sign-in.                                                                                                            |
| `/dashboard/onboarding/store`                          | Create a store; start account setup.                                                                                                                      |
| `/dashboard/onboarding/second-key`                     | Recovery-kit setup, invitation, and additional-device guidance.                                                                                           |
| `/dashboard`                                           | Test and live account cards, balances, provisioning status/retry, storage warning, and go-live checklist. Both account modes are deliberately shown here. |
| `/dashboard/payments`                                  | Payment list with status/date filters and cursor pagination.                                                                                              |
| `/dashboard/payments/[id]`                             | Amounts, fee breakdown, transactions, and refund status.                                                                                                  |
| `/dashboard/review`                                    | Held payments, unresolved screening, returns, and missing return addresses.                                                                               |
| `/dashboard/approvals` and `/dashboard/approvals/[id]` | Drafts, pending approvals, timelocks, execution history, signer approval/cancellation.                                                                    |
| `/dashboard/withdraw`                                  | Withdrawal requests through proposals.                                                                                                                    |
| `/dashboard/addresses`                                 | Saved payout addresses, activation waits, and pending proposals.                                                                                          |
| `/dashboard/settings/payout`                           | Settlement asset selection and approval through `PayoutChooser`.                                                                                          |
| `/dashboard/settings/checkout`                         | Allowed checkout domains, fee/gas defaults, payment email preferences, notification-email verification.                                                   |
| `/dashboard/settings/connected-sites`                  | Connected store integrations and disconnection.                                                                                                           |
| `/dashboard/webhooks`                                  | Endpoint management, one-time secret display, test deliveries, delivery history, and resend.                                                              |
| `/dashboard/team`                                      | Members, invites, roles, and signer-related actions.                                                                                                      |
| `/dashboard/security`                                  | Approval threshold, withdrawal limits, refund cap, auto-sweep, recovery kit.                                                                              |
| `/dashboard/recovery`                                  | Live-account recovery status/start/cancel. Recovery also has a dashboard-wide warning banner.                                                             |

Missing dashboard screens with existing backend support: payment-link management and checkout-theme management. `/dashboard/settings/checkout` currently edits checkout settings; it is not a theme editor. The public payment-link and checkout experiences already exist under `apps/web/src/app/pay/`.

## Suggested delivery order

1. **Dashboard shell and account overview.** Improve navigation, responsive layout, store/mode visibility, loading and retry states, and setup guidance. Preserve existing routes and their actions. Show balances with token-aware formatting; the current account cards expose raw smallest units.
2. **Payments and payment links.** Refine the list/detail/review flows, then add `/dashboard/payment-links` with create, detail, edit, archive/restore, URL/QR sharing, and linked payments. The new route name is a proposal, not an existing route.
3. **Checkout appearance.** Add a theme list and editor under a proposed `/dashboard/settings/themes`, beginning with presets, core branding controls, validation, preview, publish, and default selection. Add advanced block/CSS editing afterward.
4. **Operational screens.** Apply the same UI patterns to approvals, withdrawals, payout settings, team, webhooks, and security. Keep complete destination details and timed waits visible during money and security actions.

An overview can show account readiness, balances, recent payments, pending approvals, and review items using existing endpoints. Revenue time series, conversion rates, customer analytics, global payment search, CSV export, and merchant API-key management have no dedicated dashboard endpoints in this baseline. Agree on backend contracts before presenting those as working features. Never calculate a lifetime total from one paginated result or add amounts across currencies without conversion semantics.

## Session and data integration

Use `api()` from `@/lib/api` for merchant dashboard requests. Do not introduce browser-held Tendr secret keys or replace dashboard sessions with bearer tokens.

The shell loads `GET /v1/me` with `{ store: false }`. It restores the selected store and mode from per-tab `sessionStorage`, verifies membership, and exposes `me`, `store`, `context`, `selectStore`, and `refresh`. A person with no store is directed to onboarding; a person without a passkey sees the passkey gate.

The client sends `credentials: 'include'`, `Tendr-Merchant`, and `Tendr-Livemode`. Mutations send `Tendr-CSRF`, taken from the session response and retained in memory; the readable cookie is a same-host fallback. Preserve this because the production dashboard and API use different subdomains. Person-level requests use `{ store: false }`.

Use merchant ID, mode, filters, and resource ID in request/cache keys where the resource is mode-specific. Clear visible results on a context change and ignore or abort responses from an older context. **The existing `useLoad` helper has no cancellation or stale-response guard**, so harden it or supply equivalent protection when refactoring data loading. Checkout domains, fee/gas defaults, notification preferences, team membership, and themes are store-wide; label their scope because selecting test mode does not isolate those changes.

Email links can contain `?store=<id>&mode=...`. The shell checks membership before selecting that context and removes those parameters. Preserve this behavior and the sign-in return path. Never silently fall back to displaying another store's resource after a failed deep link.

### Permissions and signing

Use `can()` / `ROLE_PERMISSIONS` from `@tendr/contracts` as the role source of truth. Backend checks remain authoritative.

| Role    | Dashboard permissions                                                                       |
| ------- | ------------------------------------------------------------------------------------------- |
| Viewer  | Read account data.                                                                          |
| Finance | Viewer permissions plus `money:request`, including payment-link writes and money proposals. |
| Admin   | Finance permissions plus settings, team management, and webhook resend.                     |
| Owner   | Admin permissions plus security proposals and owner-specific operations such as go-live.    |

Role and signer status are separate. `store.isSigner` and the account's signer state determine signing eligibility; being an owner does not replace a valid signing key. Invitations and role changes can have additional owner/self restrictions already handled by the team screen.

Use `withStepUp()` for endpoints requiring a fresh passkey. It handles `STEP_UP_REQUIRED`, runs a ceremony, and retries once. Use `approveProposal()` / `cancelProposal()` for on-chain actions: they obtain a server challenge and submit the passkey assertion. A submitted approval is not proof that a transfer executed; render the returned proposal state and refresh until the backend reports the outcome.

### Error and money display rules

| Condition                                        | UI behavior                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 UNAUTHENTICATED`                            | Let the shell redirect to login and preserve the return route.                                                                                            |
| `STEP_UP_REQUIRED`                               | Run `withStepUp`; do not sign the person out.                                                                                                             |
| Closed/timed-out passkey prompt                  | Offer retry without claiming the action succeeded.                                                                                                        |
| `403 LIVE_MODE_UNAVAILABLE`                      | Explain that live payments are unavailable. Keep the backend checklist authoritative.                                                                     |
| `VALIDATION_ERROR` or `THEME_INVALID`            | Map available error details to fields; keep entered values for correction.                                                                                |
| `NETWORK_ERROR`, rate limit, or provider failure | Show a retryable state without treating uncertain writes as completed. Reuse an idempotency key for retries of the same create operation where supported. |
| Cross-store/mode `NOT_FOUND`                     | Show a missing/unavailable resource, not data from a different context.                                                                                   |

`ApiError` exposes `status`, `code`, `message`, `requestId`, and `details`. Show a request ID when useful for support, without exposing raw payloads or credentials.

Token amounts cross the API as integer strings in the asset's smallest units. Order/fiat values are decimal strings. Reuse `formatAmount`, `formatUsd`, `feeLines`, and `explorerTxUrl`; do not use floating-point arithmetic for money. Unknown assets retain their full ID and raw units. Do not render missing settlement data as zero or an estimated fee as final.

Payment states include `DETECTED`, `PROCESSING`, `SETTLED`, `PARTIALLY_REFUNDED`, `REFUNDING`, `REFUNDED`, `HELD`, and `SCREENING_PENDING`. Proposal states include `draft`, `pending`, `timelocked`, `executing`, `executed`, `cancelled`, `expired`, and `failed`. Use readable labels while retaining the underlying state for support. A countdown reaching zero is not confirmation of execution.

## API map for frontend work

| Area                      | Endpoints and contract notes                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account overview          | `GET /v1/account`, `/v1/account/balances`, `/v1/account/settlement`, `/v1/account/go-live`. Retry and go-live are `POST /v1/account/retry` and `/v1/account/go-live`, with owner/step-up requirements.                                                                 |
| Payments                  | `GET /v1/payments`, `GET /v1/payments/:id`. Filters: `status`, `created_from` inclusive, `created_to` exclusive, `payment_link_id`, `limit` 1–100, `starting_after`. Response: `{ payments, has_more, next_cursor }`. No free-text query parameter.                    |
| Proposals                 | `GET/POST /v1/account/proposals`; `GET /v1/account/proposals/:id`; `POST .../:id/challenge`, `.../:id/approve`, `.../:id/cancel`. Prefer existing helpers over duplicating ceremony code.                                                                              |
| Addresses and limits      | `GET /v1/account/saved-addresses`, `GET /v1/account/limits`. Changes are proposals, not direct edits to those read endpoints.                                                                                                                                          |
| Payment links             | `GET/POST /v1/payment_links`; `GET/PATCH/DELETE /v1/payment_links/:id`. Reads require account access; writes require `money:request`, with no step-up.                                                                                                                 |
| Themes                    | `GET /v1/themes/presets`; `GET/POST /v1/themes`; `GET/PATCH/DELETE /v1/themes/:id`; `POST /v1/themes/validate`; `POST .../:id/preview`, `.../:id/publish`, `.../:id/default`. Writes require settings permission; publish/default require step-up for dashboard users. |
| Theme assets and brand    | `GET/POST /v1/theme-assets`, `DELETE /v1/theme-assets/:id`; `POST /v1/themes/from-website` and `/v1/themes/from-store`. Uploads use multipart, not JSON.                                                                                                               |
| Review                    | `GET /v1/review`; `POST /v1/review/:paymentId/acknowledge-legal`, `.../:paymentId/refund`; `POST /v1/review/refunds/:refundId/cancel`. Preserve the owner-only legal acknowledgement and the existing return eligibility rules.                                        |
| Settings and integrations | `GET/PATCH /v1/settings/checkout`; `GET /v1/connections`, `DELETE /v1/connections/:id`. Reuse the current settings and connected-sites screens for step-up and verification behavior.                                                                                  |
| Team                      | `GET /v1/team`, `POST /v1/team/invites`, `PATCH /v1/team/:membershipId`, `GET /v1/team/:membershipId/signer-keys`.                                                                                                                                                     |
| Webhooks                  | `GET/POST /v1/webhooks/endpoints`; endpoint delete, `/rotate`, `/test`, `/deliveries`; `POST /v1/webhooks/deliveries/:id/resend`. Creation/rotation return secrets once and require step-up.                                                                           |

**Refund boundary:** `POST /v1/refunds` accepts secret API keys only. Do not wire a new dashboard refund button directly to it or expose a secret key to make it work. The current dashboard review routes handle eligible returns and cancellation of store refunds; a general refund-from-payment-detail feature needs an agreed dashboard API contract. There is no route to release a held payment into settlement.

### Payment link implementation details

Use `PaymentLinkCreateSchema` and `PaymentLinkUpdateSchema` in `packages/contracts/src/payment-links.ts`. Support fixed and open amounts, title/description, currency, optional minimum, expiry, use limit, and checkout overrides. The minimum is USD 1 equivalent before fees; surface backend FX/minimum errors.

The slug is set only on creation. `DELETE` archives; `PATCH { archived: false }` restores. Omitted PATCH fields stay unchanged; supported nullable fields clear with `null`. Use backend `availability`, totals, `url`, and `qr_url` instead of rebuilding them. A link's uses and availability are not interchangeable: an unexpired checkout can reserve capacity before a payment settles.

List filters are `status=active|inactive`, `include_archived=true|false`, `limit`, and `starting_after`. Add the existing payments filter `payment_link_id` to the UI when linking from a payment link. The backend also returns payment-link references and payer-note data through `sessionRefs`; reconcile these with `lib/payments.ts`, whose current `PaymentSummary` does not declare all those fields.

See [the payment links handover](2026-10-30-payment-links.md) for schemas, availability, reservations, totals, and errors. Use API-returned URLs: older examples in that document predate the separate pay host.

### Theme implementation details

Themes are store-wide across test and live. Saving a draft does not publish it. Publish and make-default are separate actions that can change live checkout appearance even when the dashboard is viewing test mode. Explain that scope before the action.

Display the normalized document returned after save, including sanitized HTML. Map `THEME_INVALID` details to fields. A theme can remain `published` while having unpublished draft edits; compare draft and published content rather than using its status alone.

Use the returned preview URL and honor the current preview CSP; do not assume an iframe editor preview is permitted. Preview tokens expire after 15 minutes. Preserve the sealed payment block, real amount/destination/QR, and the validators around custom text, CSS, HTML, fonts, and images.

The API client accepts other `RequestInit` options but serializes only its `json` body. Add a FormData-capable request path that preserves cookies, CSRF, merchant/mode headers, and error parsing for asset uploads. Send the asset `kind` and exactly one `file`; let the browser set the multipart boundary. Bucket credentials never belong in the frontend.

See [the checkout themes handover](2026-10-30-checkout-themes.md) for editor capabilities and validation rules. Its older GCS/public-bucket instructions are superseded for this deployment: Railway assets are served from `https://api.usetendr.tech/v1/assets`.

## Local development

Use Node 22+, npm 10+, and Docker. In your own feature checkout, create `.env` from `.env.example` **only if it does not already exist**. Keep existing credentials private; do not copy a production `.env` into a frontend fixture.

For a local-only dashboard environment, set these development values in that root `.env`:

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://postgres:postgres@localhost:15432/tendr
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:15432/tendr_test
REDIS_URL=redis://localhost:6380
API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
WEB_URL=http://localhost:3000
CHECKOUT_BASE_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000
WEBAUTHN_RP_ID=localhost
NEXT_PUBLIC_WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGINS=http://localhost:3000
MAIL_DRIVER=log
KEYVAULT_DRIVER=local
NEAR_CLIENT_DRIVER=fake
NEAR_FAKE_SIMULATE=1
MERCHANT_ACCOUNT_CODE_HASH_TEST=11111111111111111111111111111111
ASSET_STORE_DRIVER=memory
LIVE_MODE_ENABLED=false
```

The placeholder code hash is for the fake client only. Do not use it in Railway. Local fake NEAR and the local key vault are rejected in production. In-memory asset storage is enough for API/editor development but does not provide a persistent public image/font server; use a configured development asset store to test actual asset rendering.

```bash
npm ci
docker compose -f infra/docker/docker-compose.yml up -d postgres redis
npm run build --workspace=@tendr/contracts
npm run db:generate
npm run db:migrate:dev --workspace=@tendr/api
npm run db:migrate:test --workspace=@tendr/api
npm run dev
```

Open `http://localhost:3000/signup`. With `MAIL_DRIVER=log`, verification links are written to `apps/api/.mail/*.json`; use the newest message for your development email. Register a passkey, create a store, and let the worker provision the fake account. Keep the web, API, and worker running together. `npm run db:seed` supplies demo API fixtures if needed; it does not replace the merchant's email/passkey signup.

Use `localhost` consistently for WebAuthn. Production passkeys use RP ID `usetendr.tech`; changing hosts or RP IDs affects which credentials can authenticate. The current deploy compose file uses Postgres port **15432**; older README instructions mention 5433.

Frontend needs the public API URL and public RP ID. Reown is for checkout wallet connections, not dashboard passkey login. `NEXT_PUBLIC_*` values are baked into the browser build. `WEB_INTERNAL_TOKEN`, provider API keys, database URLs, vault bundles, and bucket credentials remain server-only.

## Visual and interaction requirements

Start with the existing Tendr tokens: navy `#080d1b`, indigo `#4035f5`, cyan `#16c7f7`, lavender `#c9c6ff`; Sora body, Instrument Sans display, and JetBrains Mono for addresses. Fonts are self-hosted to satisfy CSP. Scope dashboard layout changes so shared CSS does not alter checkout or its sealed payment block.

Keep the selected store and mode visible on desktop and mobile. Retain the test-mode banner and the recovery warning. Give each page loading, empty, error, permission-denied, and in-progress states. Distinguish no records from filters matching nothing. Prevent duplicate submissions and preserve form input after a recoverable failure.

Use labeled controls, visible keyboard focus, accessible dialog behavior, and status text beyond color. On small screens, keep filters usable and full destinations available. Show the complete chain and destination at approval time; a nickname or truncated address alone is insufficient. Preserve saved-address activation waits and proposal timelocks from server timestamps.

Do not cache private dashboard/API responses in the service worker or store session/CSRF secrets in localStorage. Preserve nonce-based CSP and the existing WebAuthn ceremonies when adding UI libraries.

## Verification and completion

Run the workspace checks appropriate to the changed screens:

```bash
npm run typecheck --workspace=@tendr/web
npm run lint --workspace=@tendr/web
npm run test --workspace=@tendr/web
npm run test:e2e --workspace=@tendr/web -- merchant-accounts.spec.ts
```

Playwright starts its own API/worker/web against `TEST_DATABASE_URL`, with fake NEAR and a virtual passkey authenticator. It uses web port 3100, API port 4100, and fixture-store port 3200 by default. Stop the normal development stack if its worker health port 4100 conflicts. The test suite's enabled live flag is confined to its fake environment and is not a production launch setting.

Use `checkout.spec.ts`, `payment-links.spec.ts`, and `themes.spec.ts` when changing shared checkout, link, or theme behavior. Existing suites cover those public experiences, not the missing dashboard editors; add focused coverage for the new merchant workflows. Useful unit regression files under `apps/web/src` include `lib/api.test.ts`, `lib/payments.test.ts`, `lib/actions.test.ts`, and `components/dashboard/GoLiveChecklist.test.tsx`.

A dashboard change is ready for review when:

- The implemented screens use real API data and render useful loading, empty, error, and permission states.
- Switching stores or modes cannot display stale data or submit an action for the wrong context.
- Viewer, finance, admin, owner, signer, and non-signer behavior matches the API permissions.
- Signup/sign-in, step-up cancellation, session expiry, and signed-out return navigation still work.
- Amounts, destination details, fee estimates, pending transfers, and timed waits are represented accurately.
- Payment links use backend availability and URLs; theme drafts and publish/default actions remain distinct.
- Mobile and keyboard flows work, and checkout/theme rendering survives shared-style changes.
- The PR includes screenshots, the checks run, and any backend dependency that remains unresolved. Production payment verification belongs to the deployment owner after the outstanding setup is complete.

## Further references

- [Merchant accounts design](../superpowers/specs/2026-10-25-merchant-accounts-design.md)
- [Checkout core design](../superpowers/specs/2026-10-25-checkout-core-design.md)
- [Payment links handover](2026-10-30-payment-links.md)
- [Checkout themes handover](2026-10-30-checkout-themes.md)
- Deployment runbook on `deploy`: `docs/handover/2026-10-31-deploy-runbook.md`
- [Railway project](https://railway.com/project/a2f21ff5-5b3e-49f1-beb7-8990234aeca8)
