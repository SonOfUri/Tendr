# Tendr API test console

Branch: `test/api-console`, based on the deployed code. The console is at `/settings/api-console` and includes all 133 explicitly registered API routes, with a searchable list, editable path/query parameters and JSON, browser-session or bearer authentication, multipart uploads, optional HMAC signing, and a response inspector.

Selecting an endpoint does not send it. Press **Send request** to execute one operation. This is a manual API workbench; it does not automatically run every endpoint or bypass permissions, signer approvals, provider credentials, or wallet signatures.

## Start locally

Use Node 22+, npm 10+, and the local PostgreSQL/Redis services. Run these from the repository root:

```bash
git switch test/api-console
npm ci
# On a fresh checkout only, create .env from .env.example.
docker compose -f infra/docker/docker-compose.yml up -d postgres redis
npm run dev:console
```

Open **http://localhost:3300/settings/api-console**. The API runs at `http://localhost:4300`.

The launcher reads the connection credentials from the root `.env`, requires localhost databases, and uses its own PostgreSQL database **`tendr_api_console`** and Redis database **8**. It applies migrations, uses a separate local key vault, and starts API and worker in one process so they share the simulated NEAR state. The normal app databases and Railway are not modified.

Match `DATABASE_URL` to the port exposed by your local PostgreSQL container: the current compose file uses 15432; an older running container may use 5433. `API_CONSOLE_WEB_PORT` and `API_CONSOLE_API_PORT` override 3300 and 4300 if needed. Stop the launcher with Ctrl+C.

Email appears in the **Local inbox** at `http://localhost:3300/settings/local-mail` instead of being sent to your email address. Signup links directly to the inbox filtered to your address. FX and payments are simulated, live money is disabled, and uploaded assets are kept in memory and served through the local API. The launcher removes inherited provider credentials and prevents the app from reloading them from `.env`. PostgreSQL records and simulated wallet state survive a restart; keep `.keyvault/api-console-state.bin` with database backups. Uploaded files remain in memory.

## Live API locally

To run this branch's frontend against the deployed API, use:

```bash
npm run dev:console:live
```

This starts only the local frontend, bound to `127.0.0.1:3343`, and opens a dedicated Chrome
window at **https://app.usetendr.tech/dashboard**. In that window, the app hostname resolves
to the local server; requests to **https://api.usetendr.tech** still go to Railway. The page
shows **Local dashboard · Live API**. Other browser profiles continue using the hosted frontend.
The production RP ID, origins, CORS policy and DNS remain unchanged.

Use your deployed Tendr account, or sign up in that window. Simulator accounts and `localhost`
passkeys are separate. Signup emails come from the deployed mail provider. Copy email verification
links into the dedicated window's address bar so signup finishes in the same browser profile.
Once signed in, choose your store, select **Live**, and open **Live wallet**. Live operations use
real funds and require the designated owner's wallet passkey. The launcher does not send payments.
Hosted shopper checkout links still open on `pay.usetendr.tech`; shopper-only API routes retain
their checkout-origin CORS restriction and should be exercised through that checkout.

The dedicated browser's cookies and local HTTPS key are kept under the ignored
`.keyvault/live-console/`. Chrome maps only the app hostname and accepts only that local
certificate's public-key fingerprint, using Chromium's
[host resolver and certificate pin options](https://chromium.googlesource.com/chromium/src/+/main/services/network/public/cpp/network_switches.cc).
There is no system-wide certificate installation or hosts-file edit. Close this Chrome window
when finished. Stop the server with Ctrl+C. To reopen the window while the server is running:

```bash
npm run dev:console:live -- --open
```

Configuration is read from the Git-ignored, private `.keyvault/live-console.json`, already set
up in this workspace from Railway. On another machine, create it with mode `0600` using the
deployed web settings:

```json
{
  "WEB_URL": "https://app.usetendr.tech",
  "NEXT_PUBLIC_API_BASE_URL": "https://api.usetendr.tech",
  "CHECKOUT_BASE_URL": "https://pay.usetendr.tech",
  "NEXT_PUBLIC_WEBAUTHN_RP_ID": "usetendr.tech",
  "WEB_INTERNAL_TOKEN": "<copy the deployed server-only value privately>"
}
```

Optional web values are `NEXT_PUBLIC_REOWN_PROJECT_ID`, the EVM/Tron forwarder addresses,
`NEXT_PUBLIC_GAS_FEE_RECIPIENTS`, and `TENDR_ASSET_ORIGIN`. No Railway token or database/provider
credentials are passed to the frontend. The launcher skips root `.env`, uses a separate
`.next-live-console` build cache, and does not run migrations or workers. Node 22+, OpenSSL and
Chrome are required. `LIVE_CONSOLE_CHROME` overrides Chrome's executable, `LIVE_CONSOLE_PORT`
overrides 3343, and `--no-browser` starts only the server. Close the dedicated Chrome profile
before changing its host/port/certificate settings.

## Authenticate

For dashboard APIs, use your browser session:

1. Select `POST /v1/auth/email/start`, enter a development email, and send it. Open **Local inbox** from the console and find your message; no email is sent externally. The existing signup page also provides an **Open local inbox** link.
2. Click **Verify email and continue**, then confirm your email. For testing the raw API, the message details also contain the verification URL: put its token into `POST /v1/auth/email/verify` and send it. These public authentication endpoints default to **Browser session** so the browser accepts their session cookies.
3. Press **Register passkey**, then create a store with `POST /v1/merchants`.
4. Press **Load session** to load your stores and CSRF token. Store-scoped endpoints automatically enable the merchant/mode controls. Test is the default.
5. When an API returns `STEP_UP_REQUIRED`, press **Step up**, then resend the request. Login after a reload with **Sign in with passkey** or **Load session** if the cookie is still valid.

You can also use the existing signup/dashboard pages and return to the console. WebAuthn uses RP ID `localhost`; keep the browser on `localhost`, not `127.0.0.1`.

For a form-based payment-link workflow, open **Payment links** in the dashboard at `http://localhost:3300/dashboard/payment-links`. Create fixed or customer-chosen amounts, copy the checkout URL, open its QR code, edit or pause a link, and archive or restore it. Link options include a custom URL name on creation, expiry, and a payment limit. Links and form drafts are scoped to the selected store and test/live mode; viewer accounts can browse and share only. A saved link shows **Store setup needed** until the account and payout configuration are ready.

Under **Settlement token**, keep **Use store default** or select **Choose a token for this link**,
then choose its **Asset chain** and **Token to receive**. A chain selection identifies the token
version credited to the same Tendr account; it does not pay an external wallet. An explicit token
needs an active account but does not require a store default. Existing checkout sessions retain
their original asset when you edit a link. The catalog comes from
`GET /v1/payment_links/settlement-options`: simulated assets in local test mode, provider assets
in live mode. Choosing a live token does not enable live payments or provision a mainnet account.

For API-key endpoints, open **API keys** in the dashboard at `/dashboard/api-keys`. Choose your
store and Test/Live mode, name the key and select its permissions, then create it with your login
passkey. Copy the secret when it appears; it is shown once. Use it in the console's **Bearer token**
field or in your server's environment. The key belongs to the selected store and mode. Owners and
admins can also view key prefixes, permissions and last use, and revoke keys here. Connected-site
credentials remain under **Connected sites**. Local simulator live writes remain disabled.

If a creation response is lost, refresh the key list and revoke that new key before creating a
replacement. Key creation does not accept `Idempotency-Key`, to keep raw secrets out of the retry
cache. Changing store/mode or leaving the page clears the one-time secret.

Alternatively, to create a separate Demo Merchant for local API testing, run:

```bash
npm run console:seed
```

The seed creates the Demo Merchant and prints its new keys once. Use its **test secret key** or **test publishable key** in the console's Bearer token field. These belong to the Demo Merchant, not the store you created with your browser session. A repeat seed does not print existing keys again. Tokens are never saved by the console.

For shopper APIs, use the **session client secret** returned when creating a checkout session. For connected-site APIs, use a real **connection key** obtained through the Connect/PKCE flow. Bearer authentication omits browser cookies and store headers; the token determines the merchant and mode.

## Useful test flows

| Flow                   | Requests                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and permissions | `GET /v1/health`, `/v1/ready`, `/v1/me`, `/v1/ping`; compare public, browser session, and bearer authentication.                                                                                                                                                                                              |
| Account setup          | Create a store, load the session, then `GET /v1/account`, `/v1/account/balances`, `/v1/account/go-live`. Go-live writes return `LIVE_MODE_UNAVAILABLE` in the local launcher.                                                                                                                                 |
| Checkout               | With the seeded test secret key, create `POST /v1/checkout/sessions`. Switch to the returned client secret; read `/v1/checkout/client/tokens`, request a quote, then `/v1/checkout/client/simulate` with `exact`, `underpay`, `overpay`, `late`, `failed`, or `topup`. Copy IDs and asset IDs from responses. |
| Payment links          | Create/list/read/edit/archive through `/v1/payment_links`; use the public read/session routes with `mode=test` for the shopper side. A newly created store needs payout setup before it can accept payments.                                                                                                  |
| Themes and uploads     | Create a blank theme, upload a logo/image/font, patch its draft, validate, preview, publish, or make it default. Themes and checkout settings are shared across modes.                                                                                                                                        |
| Proposals              | Draft an action, get its challenge, use the passkey helper, submit the prepared assertion, then read its status. An approval is not proof of execution.                                                                                                                                                       |
| Refunds and review     | Use a secret API key for `/v1/refunds`; use a dashboard session for `/v1/review`. Preserve the backend's eligibility and legal acknowledgement requirements.                                                                                                                                                  |

The JSON examples are starting points for common writes. Replace placeholders with actual test IDs, addresses, and values. Complex requests such as recovery-kit proofs, PKCE redemption, gas policy, and signed wallet submissions need their real payloads; the selected endpoint shows its source file and declared authentication contract.

After a successful WebAuthn options/challenge request, **Use passkey and prepare verification** invokes the browser ceremony and fills the matching verification/approval/cancellation request. Review it, then send it. This helper supports passkey registration/login/step-up and signer challenges; it does not generate recovery-kit or wallet signatures.

For asset uploads, select **Multipart asset upload**, choose `logo`, `image`, or `font`, and choose one file. Extra headers accept a JSON object. **New idempotency key** generates one for a new logical operation; retain it when retrying that operation. Optional HMAC signing uses the exact serialized request bytes, including multipart boundaries.

Responses show HTTP status, elapsed time, browser-readable headers, and formatted JSON or text. Binary responses are identified rather than rendered. The response display is capped at 1 MiB. Requests time out after 30 seconds; cancellation does not guarantee that a submitted write was rolled back. Read the resource state before retrying an uncertain write.

**Clear inputs and results** removes tokens, signatures, request bodies, responses, and history from the page. It does not sign out the session; use **Sign out** for that. No request history or token is persisted to localStorage/sessionStorage.

## A separate test deployment

The console is available by default only in development. For a dedicated test web deployment, set **`API_CONSOLE_ENABLED=true`**. Unset it in production, or set it to `false` to disable it explicitly; the page then returns 404. Keep `NODE_ENV=production` for deployed services.

The local inbox is stricter: it requires development mode, explicit console enablement, `MAIL_DRIVER=log`, and localhost web/API origins. It returns 404 in production even when the console is enabled. Mail responses are never cached and cross-origin reads are refused. The underlying development messages remain in `apps/api/.mail/`.

Set the web build's `NEXT_PUBLIC_API_BASE_URL` to that environment's API. For one console origin to exercise both dashboard and shopper endpoints, configure that test environment's `WEB_URL`, `CHECKOUT_BASE_URL`, `CORS_ORIGINS`, and WebAuthn origins to the same web origin. Configure the matching RP ID on the API and web. Do not widen production CORS or change the live dashboard's RP ID to accommodate a testing page.

The local launcher is not a Railway start command. Production services still enforce real NEAR/provider setup and their normal guards. Merely setting the console flag does not simulate payment infrastructure. This branch does not automatically provision or deploy a separate Railway environment.

## Maintain and verify

The catalog generator parses TypeScript route declarations without starting the API or reading environment credentials. Regenerate after changing routes:

```bash
npm run api-console:catalog --workspace=@tendr/web
npm run api-console:check --workspace=@tendr/web
npm run typecheck --workspace=@tendr/web
npm run lint --workspace=@tendr/web
npm run test --workspace=@tendr/web -- src/lib/api-console/request.test.ts src/middleware.test.ts
npm run test:api-console --workspace=@tendr/web
```

Browser tests use the isolated console stack and create their own test account. They cover the catalog, real API responses, authentication isolation, email/passkey signup, store-scoped writes, multipart upload, preview, and the live-mode guard. The dashboard payment-link flow also checks create retries after a lost response, editing, archive/restore, public checkout/QR URLs, store/mode isolation, and mobile width. They keep trace/video/screenshots off because responses can contain temporary credentials. The console uses the signing-page CSP, denies framing, and returns `Cache-Control: no-store`.
