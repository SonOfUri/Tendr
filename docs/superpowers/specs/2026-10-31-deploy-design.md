# Deploy: one production environment, test now, live behind a switch

Status: draft, reviewed by a builder check (awaiting the user's approval)
Date: 2026-10-31

## Intent

Put what is built (projects 1–5c) on the real domains as one production environment. Merchants can
sign up and use test mode there straight away. Everything live mode needs is also set up and
checked with our own small funds, but merchants cannot go live until one platform switch is turned
on. The switch waits for the independent audit of the merchant-account contract (the audit gate in
`2026-10-25-merchant-accounts-design.md`).

Why now: so the product can be shown and used on its real addresses, and so that when the audit
lands, going live is flipping one setting rather than a second project.

## Decided by the user

- One environment, not a separate staging stack. Test mode on the real domains first; live later.
- Accounts: Railway (hosting), GCP (KMS, plus storage), Namecheap (DNS), Resend (email).
- `usetendr.tech` (landing) and `demo.usetendr.tech` stay on Vercel and are not touched.
- Addresses:
  - `pay.usetendr.tech`: what shoppers see. Payment links are `pay.usetendr.tech/<merchant>/<link>`
    and checkouts are `pay.usetendr.tech/<session>` (no `/pay` prefix).
  - `app.usetendr.tech`: sign-in, the dashboard, settings and the WooCommerce connect screen.
  - `api.usetendr.tech`: the API.
- Live mode launches **without gasless**. Shoppers pay their own network fee in live mode until the
  TendrForwarder is externally reviewed, deployed and the relayer wallets are funded. Gasless stays
  available in test mode.
- Live is built and checked now but **merchant go-live stays off until the merchant-account
  contract audit is done**.
- The user owns `tendr.near` and `usetendr.near` on mainnet. Defaults stay: merchant accounts under
  `tendr.near`, fees to `fees.tendr.near` (a sub-account the user can create from `tendr.near`).
- The user owns `tendr.testnet`; nothing is published on it yet, so the runbook publishes the
  testnet contracts.
- No dashboard UI work.

## Goals

1. The web app, API and worker run on Railway, with Postgres and Redis there too, built and
   configured by Terraform.
2. One Next.js web service answers on both `pay.` and `app.`, and serves each host only its own
   pages.
3. Every URL Tendr hands out (session `url`, link `url` and `qr_url`, refund-address links, theme
   previews, emails, the embed script, the WooCommerce plugin) uses the new addresses.
4. Real email through Resend.
5. Theme assets in a public GCS bucket.
6. Signing keys in GCP KMS (the existing `infra/terraform/gcp`).
7. Live mode ready: mainnet accounts, contract and keys in place, the two mainnet check scripts
   pass, and a platform switch keeps merchants from going live until it is turned on.
8. A runbook that lists each outside step in order, with who does it.

## Non-goals

- Gasless in live mode (forwarder deploy, Pimlico, relayer/gas-fee wallet funding, fee sweep).
- A staging environment, preview deployments, or autoscaling.
- Moving the landing page or demo off Vercel.
- Dashboard UI changes beyond what the address split forces (links and redirects).
- Project 6 (AI, Shopify, agent API) and project 7.

## Anti-goals (a failure even if it "works")

- A merchant can go live, or a live payment can settle into a merchant account, before the switch
  is turned on.
- A live checkout offers gasless.
- A secret ends up in the repo, in Postgres in plain text, or in a URL.
- Old links break: any `/pay/…` URL already handed out (in tests, emails, the demo) must keep
  working by redirecting.
- Production starts with a localhost or http origin anywhere because a variable was forgotten.

## Constraints

- Every outward step (push, `terraform apply`, DNS, account or money actions, mainnet transactions)
  is confirmed with the user first.
- Never store private keys or plaintext secrets in Postgres. API keys for outside services stay
  env vars on Railway, as `ONECLICK_API_KEY` and `FX_API_KEY` already are.
- No software installed on the host; use Docker (e.g. the `hashicorp/terraform` image) for tooling.
- Commits carry no Claude attribution lines.

## The design

### 1. Hosts and routing (web)

One Next.js app, one Railway service, two custom domains. Middleware decides by `Host`:

- **pay host** (`CHECKOUT_BASE_URL`'s host):
  - `/<session>` → internally rewritten to the existing `/pay/<session>` page (and its
    `refund-address` sub-page).
  - `/<merchant>/<link>` (and `qr`, `opengraph-image`, `twitter-image`) → rewritten to
    `/pay/<merchant>/<link>/…`.
  - Also served as-is: `/preview/theme/<token>`, `/checkout-boot.js`, `/v1/tendr.js`,
    `/v1/plugins/woocommerce/update.json`, `/downloads/woocommerce`, `/privacy`, `/terms`, Next's
    own assets.
  - `/pay/…` (old form) → 308 redirect to the same path without `/pay`.
  - Merchant pages (`/dashboard`, sign-in pages, `/connect`, settings verify) → 308 to the app host.
  - `/` → 308 to `https://usetendr.tech`.
- **app host** (`WEB_URL`'s host):
  - Sign-in pages, `/dashboard/*`, `/connect`, `/settings/notification-email/verify`.
  - `/` → `/dashboard` (which already sends signed-out users to sign-in).
  - Shopper paths (`/pay/…`, `/preview/theme/…`) → 308 to the pay host in its new form.
- **Any other host** (Railway's own `*.up.railway.app` name, localhost in dev, and the Vercel
  `demo.usetendr.tech` build of this same app): behave as today, so local dev, the e2e suite and
  the demo keep working with one origin. In dev, both new path forms work on `localhost:3000`.
- `/demo`, `/demo/<slug>` and `/api/demo/*` are 404 on the pay and app hosts. Production has no
  demo merchant; the demo keeps its own Vercel deployment and settings.

The page files stay where they are (`app/pay/[id]`, `app/pay/[id]/[link]`); the middleware rewrite
does the mapping. Client code that reads `location.pathname` sees the public form, so every place
that matches `/pay/` must accept the root form too: `lib/checkout/frame-origins.ts`,
`lib/checkout/boot-secret.ts`, `embed/tendr.ts` (`SESSION_PATH`), `lib/wallets/popup.ts`,
`components/HideOnCheckout.tsx`, `public/sw.js`, and the middleware's own `LINK_ASSET` regex and
checkout check.

Root-level merchant slugs must not collide with pay-host paths. The reserved-slug lists
(`apps/api/src/merchants/reserved-labels.ts`, `RESERVED_LINK_SLUGS` in
`packages/contracts/src/payment-links.ts`) must include every top-level segment the pay host serves
(`pay`, `preview`, `v1`, `downloads`, `privacy`, `terms`, `checkout-boot.js`, `_next`, `api`,
`favicon.ico`, `robots.txt`, `sw.js`, and the rest found in `app/` and `public/`). A session id
always starts `ses_`, which merchant slugs already cannot.

Security headers per host: the pay host keeps the checkout CSP; merchant pages keep
`X-Frame-Options: DENY` and their CSP (now matched by host as well as path).

### 2. URLs Tendr hands out (API, WooCommerce, embed, docs)

- API:
  - `CHECKOUT_BASE_URL=https://pay.usetendr.tech`.
  - Session URL: `${CHECKOUT_BASE_URL}/${id}`.
  - Link URL: `${CHECKOUT_BASE_URL}/${merchant}/${link}`.
  - Refund address: `${CHECKOUT_BASE_URL}/${id}/refund-address?t=…`.
  - Theme preview: unchanged path, on the pay host.
- `WEB_URL=https://app.usetendr.tech` for every email link and dashboard link.
- `API_BASE_URL=https://api.usetendr.tech`.
- `CORS_ORIGINS=https://app.usetendr.tech`. Shopper-route CORS keeps using `CHECKOUT_BASE_URL`'s
  origin.
- Passkeys: `WEBAUTHN_RP_ID=usetendr.tech`, `WEBAUTHN_ORIGINS=https://app.usetendr.tech`, and
  `NEXT_PUBLIC_WEBAUTHN_RP_ID=usetendr.tech`. *My call:* the parent domain, so passkeys survive if
  the dashboard ever moves to another subdomain. An RP ID cannot be changed later without every
  passkey being re-registered.
- Cookies stay host-only on `api.usetendr.tech`. app→api is same-site, so the `SameSite=Lax` cookies
  already flow; nothing changes.
- Production validation: the API's `env.ts` must reject, at `NODE_ENV=production`, a
  `CHECKOUT_BASE_URL`, `WEB_URL`, `API_BASE_URL` or `CORS_ORIGINS` entry that is not https or that
  points at localhost. *My call:* the web app gets no new boot check, because the Vercel demo
  builds the same app with its own settings and must not start failing; the API builds every URL
  Tendr hands out, so checking there is enough.
- CORS: the builder lists every API route the pay-host pages call (checkout, links, refund
  address, theme preview, wallet popup, embed) and confirms that each one is on the shopper CORS
  list (`CHECKOUT_BASE_URL`'s origin), and that none needs the dashboard's credentialed CORS. If
  one does, it is split or moved, with a test.
- The embed (`scripts/build-embed.mjs`) bakes `https://pay.usetendr.tech` as its fallback. The
  fallback `'https://usetendr.tech'` is wrong today.
- WooCommerce plugin, version 0.3.0:
  - Defaults are `API_BASE=https://api.usetendr.tech`, `CHECKOUT_BASE=https://pay.usetendr.tech`,
    and a new `APP_BASE=https://app.usetendr.tech`, overridable with the `TENDR_APP_BASE`
    wp-config constant.
  - `/connect` uses the app base; the script, update feed and downloads use the checkout base.
  - The session-URL check accepts `<checkout base>/ses_…`. It also accepts the old `/pay/ses_…`
    form for one version.
  - Tests are updated. No connected live stores exist, so no migration is needed.
- Docs: replace the old URLs in `apps/docs` (payment links overview, API reference for links and
  themes), and in the README's WooCommerce live checklist (the download URL moves to
  `https://pay.usetendr.tech/downloads/woocommerce`).

### 3. Email (Resend)

- A `ResendMailer` implementing `Mailer` in `apps/api/src/auth/mailer.ts` sends through Resend's
  HTTP API with `fetch`, matching how the codebase calls other HTTP providers. It adds no SDK.
- `MAIL_DRIVER` gains `resend`, and production defaults to it.
- New env vars:
  - `RESEND_API_KEY`, required when the driver is resend.
  - `MAIL_FROM`, default `Tendr <no-reply@usetendr.tech>`.
- It renders the same subject and text the log driver records today.
- Error handling:
  - A non-2xx response throws, so the existing per-recipient retry (merchant payment emails)
    keeps working.
  - Error logs never include the key.
- A test uses a stubbed `fetch` to cover the request shape, the auth header, and the failure path.
- Resend's domain records (SPF/DKIM, and the return-path MX) go into Namecheap from the runbook.
  *My call:* sending from `usetendr.tech` itself, not a subdomain like `mail.usetendr.tech`, since
  the landing page has no mail of its own.

### 4. Asset storage (GCS)

- Terraform (`infra/terraform/gcp`) adds:
  - a bucket `tendr-assets-prod` (uniform access, public read for `allUsers` as object viewer,
    CORS allowing `GET` from `https://pay.usetendr.tech` and `https://app.usetendr.tech` for
    fonts);
  - a service account for it with object admin on that bucket only;
  - an HMAC key for that account.
- The API uses the existing s3 driver with:
  - `ASSET_S3_ENDPOINT=https://storage.googleapis.com`
  - `ASSET_S3_REGION=auto`
  - `ASSET_S3_FORCE_PATH_STYLE=true`
  - the HMAC id and secret
  - `ASSET_S3_BUCKET=tendr-assets-prod`
  - `TENDR_ASSET_ORIGIN=https://storage.googleapis.com/tendr-assets-prod`
- One check before relying on it: an upload through the S3 SDK to GCS interop succeeds with the
  headers the driver sends (`Cache-Control`, content type). If the SDK's default checksum headers
  are rejected, set the client's checksum option to "when required". This is a known GCS interop
  quirk.
- *My call:* a second bucket `tendr-assets-dev` with its own HMAC key, for local development in
  place of MinIO (whose image can no longer be pulled). It is optional, behind a Terraform variable
  that defaults to on.

### 5. Hosting (Railway Terraform)

`infra/terraform/railway` gains:

- A `web` service:
  - build: `npm ci --include=dev && npx turbo run build --filter=@tendr/web...` (the build includes
    `build:embed` and the font copy);
  - start: `next start` on `$PORT`;
  - health check: a page that does not need the API.
- Custom domains: `pay.usetendr.tech` and `app.usetendr.tech` on web, `api.usetendr.tech` on api.
  The CNAME targets Railway gives back are outputs, so the runbook can list them for Namecheap.
- Every variable the services need, split into:
  - shared: origins, `NODE_ENV`, GCP/KMS;
  - api and worker: DB, Redis, 1Click, FX, mail, assets, NEAR live settings, the `*_ENABLED` flags;
  - web: `NEXT_PUBLIC_*`, `WEB_INTERNAL_TOKEN`, `CHECKOUT_BASE_URL`, `TENDR_ASSET_ORIGIN`.
- Secrets are Terraform variables marked `sensitive`, supplied in a git-ignored
  `terraform.tfvars`. `WEB_INTERNAL_TOKEN` is generated by `random_password`.
- `NEXT_PUBLIC_*` values and `TENDR_CHECKOUT_BASE_URL` are build-time, so they must be service
  variables present at build.
- Migrations stay as the api's pre-deploy step. The worker must not also migrate.
- Database roles, following `infra/terraform/README.md`: migrations run as the owner
  (`DATABASE_MIGRATE_URL`, used only by the pre-deploy step), and the api and worker connect as the
  least-privilege `tendr_app` role. The role and its grants come from a migration or a script that
  the pre-deploy step runs. The builder picks which and documents it. *My call:* to stick to the
  stated intent instead of shipping owner credentials.

Both Terraform stacks get a GCS remote backend (`tendr-tfstate`, versioned, private). The user
creates it once by hand, since Terraform cannot keep its own state in a bucket it is creating.
State holds secrets (HMAC secret, service-account key, Railway variables), so the bucket stays
private to the user's account.

The KMS service-account key that becomes `GCP_CREDENTIALS_JSON` is created by Terraform
(`google_service_account_key`) and passed to Railway through the stack outputs. *My call:* this
avoids a manual copy-paste of a key file. The cost is that the key also sits in state, which is
private.

### 6. Live mode, without gasless, behind a switch

**The switch.** A new env flag `LIVE_MODE_ENABLED` (default `false`, in `globalPassThroughEnv`).

- While it is false:
  - the API refuses every path that makes or uses something live: creating a live account
    (provisioning a mainnet merchant account), switching a merchant to live mode, creating live
    API keys, and live sessions and links. It returns a clear error code, e.g. `403
    LIVE_MODE_UNAVAILABLE`, with a message saying live payments are not open yet;
  - the dashboard's existing "what is missing to go live" list shows it as the first missing item;
  - everything in test mode is unaffected.
- The builder finds every live entry point (account provisioning in `accounts/accounts.ts`, the
  livemode switch, live key creation, live session/link/quote creation, the WooCommerce "switch to
  live") and gates each one. The gate is tested for each.
- The mainnet check scripts do not go through the API, so they still run while the switch is off.

**No gasless in live.** In live mode, gasless must be cleanly unavailable while it is unconfigured:

- the checkout never offers sponsorship;
- quotes never include a sponsored path;
- nothing calls Pimlico or a relayer.

The forwarder address cannot be unset (a blank value falls back to the shared default address), so
add an explicit `GASLESS_LIVE_ENABLED` flag (default `false`, API and the web's public env). While
it is false, every live relayer path (EVM, Solana, NEAR, Tron) returns "gasless not available", and
the live checkout hides the option. Tests cover each family. Test-mode gasless is unchanged: it is
simulated, so it needs no funded wallets. `FEE_SWEEP_ENABLED` stays `false`.

The WooCommerce plugin's "switch to live" goes through the API, so it is gated there. If the
plugin changes local state before the API answers, 0.3.0 handles `LIVE_MODE_UNAVAILABLE` and
leaves the store in test mode, with a test.

**Testnet pieces, needed for test mode in production.** Production forces the rpc NEAR driver,
so test-mode sign-up creates real testnet accounts:

- `tendr.testnet` must be funded, with the production `funding-near` KMS public key added. The
  account `relayer-accounts` signs with must be funded on testnet.
- `intents-mock.tendr.testnet` and the testnet merchant-account code must be published
  (`onchain:publish:testnet`), and `MERCHANT_ACCOUNT_CODE_HASH_TEST` set.
- `fees.tendr.testnet` must exist as a merchant account.

These come before the smoke test.

**Mainnet pieces, set up now** (runbook steps; each money-moving step is confirmed with the user):

1. GCP KMS keys exist (Terraform). `npm run kms:verify` passes against production.
2. `tendr.near` is funded (amount in the runbook, from `FUNDING_DAILY_CAP_YOCTO` and the
   per-account amounts). The `funding-near` KMS public key is added to it as an access key that
   can create sub-accounts. The runbook shows the exact `near` CLI command, run in Docker.
3. The account `relayer-accounts` signs with exists and is funded for merchant contract calls.
4. `fees.tendr.near` is created as a merchant account (passkey-protected, like a store's; README
   "fee accounts"), so fees can be delivered.
5. The merchant-account wasm (`onchain/merchant-account`) is built reproducibly and published as a
   global contract on mainnet. `MERCHANT_ACCOUNT_CODE_HASH_LIVE` is set to its hash. The audit
   later covers this exact hash; if the audit changes the code, a new hash is published before the
   switch flips.
6. Outside keys: a 1Click API key (`ONECLICK_API_KEY`), a Chainalysis key for screening, and an
   Open Exchange Rates plan with 5-minute updates (`FX_PROVIDER=openexchangerates`, `FX_API_KEY`).
   Production refuses to boot without the 1Click key and an FX key, so these are needed before the
   first deploy. The free OXR plan is enough to boot and for test mode; the paid plan is needed
   before the switch flips.
7. `npm run checkout:verify:mainnet` (capped at $5) and the merchant-account mainnet check both
   pass, using the user's own funded account.

**Turning live on later** is a runbook section of its own:

1. The audit is done, and the published hash is the audited one.
2. The OXR plan is paid.
3. Set `LIVE_MODE_ENABLED=true`.
4. Go live with one real merchant (ourselves) and pay one small live order through a payment link
   and one through WooCommerce.

### 7. Runbook

`docs/handover/2026-10-31-deploy-runbook.md`, in the order things must happen. Each step names who
does it ("you" or "me, after you confirm") and how to check it worked. It also gets a section in
the README that links to it. Steps:

1. Accounts and keys: Railway token, GCP project and credentials, Resend key, 1Click key,
   Chainalysis key, OXR app id.
2. The state bucket.
3. GCP apply.
4. Railway apply.
5. DNS at Namecheap: CNAMEs for `pay`, `app` and `api` to Railway's targets; Resend's records; the
   `docs` CNAME to Mintlify if the docs project is connected.
6. The first deploy: the push, then a check that the migration ran.
7. Seeding? No: production gets no demo merchant.
8. A smoke test on the real domains, in test mode:
   - sign up;
   - receive the magic link by email;
   - add a passkey;
   - create a test link;
   - pay it at `pay.usetendr.tech/<merchant>/<link>`;
   - open an old `/pay/…` URL and check it redirects;
   - upload a theme logo;
   - connect a WooCommerce store against production.
9. The mainnet pieces from §6.
10. The "turn live on" section.

Docs at `docs.usetendr.tech` is a Mintlify project the user connects to the repo. It is listed in
the runbook, and needs no code.

## Left to the builder

- How the middleware rewrite is structured, and how hosts are compared (from the env URLs, never
  hard-coded hostnames).
- The exact reserved-slug list, found by listing `app/` and `public/`.
- Where `LIVE_MODE_ENABLED` is checked (a shared guard is preferred to per-route copies), and the
  error code name if `LIVE_MODE_UNAVAILABLE` clashes with an existing one.
- The Railway Terraform provider's resource names for domains and variables. If the provider cannot
  set something, it goes in the runbook as a manual step.
- The NEAR funding amounts in the runbook, worked out from the caps in `env.ts`.

## Risks

- **GCS S3 interop.** The SDK's checksum headers may be rejected. This is covered by the check in
  §4, with S3-compatible R2 as the fallback.
- **Passkey RP ID.** It is permanent once users register passkeys, so it must be right on the first
  deploy.
- **Unaudited contract on mainnet.** It is published, but no merchant funds reach it while the
  switch is off. Only our own test funds touch it, through the check script.
- **Pre-existing e2e failures** (`gasless.spec.ts:214`, `smoke.spec.ts`) are not from this work.
  They are noted, not fixed, unless the address change touches them.
