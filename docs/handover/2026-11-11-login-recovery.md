# Login recovery: frontend and deployment handover

Implemented 11 November 2026 on `test/api-console` (`286cc9e`) and ported to `deploy` (`3999f11`, with responsive recovery styles in `7cae276`). The production port preserves the redesigned dashboard, uses its auth components and HTML email shell, and gives the longer recovery forms normal page scrolling on small screens. The reference screens are `/settings/login-recovery` and `/recover/login`. This feature is personal identity recovery, shared across Test/Live and all stores. It does not implement native-wallet recovery or legacy contract recovery.

## User journey

New users are offered recovery-code setup after registering their first login passkey. Existing users open **Login recovery** from the dashboard or console session tools. Show backup login passkeys, add/remove controls, remaining code count, generation and download. Adding/removing keys uses the existing protected passkey endpoints. Do not allow deleting the last active key.

Generating codes requires a verified email, at least one login passkey and a current session with a passkey confirmation no older than ten minutes. Use `withStepUp`. The ten random codes are shown once; require a save acknowledgment before hiding them or leaving onboarding. Keep plaintext in component memory only, with an optional explicit download. Never write codes to analytics, session/local storage, logs or console history. Losing the displayed copy requires generating a new set. Generation invalidates all previous codes and pending recovery links.

On loss, the user explicitly requests an email, opens its link, enters one saved code, and explicitly starts a new passkey registration. Merely opening an email/link must not consume anything. Read `#token` once, strip it from the address bar and retain it in memory. Reloading requires reopening the email. There is no account creation, store creation, wallet setup or funds movement in this flow.

Successful completion replaces every old login passkey, revokes existing sessions and consumes one saved code plus all pending recovery requests. It preserves the same user, memberships and wallet records. The UI must clear cached session/CSRF state and offer a new passkey sign-in, not assume an authenticated session. The nine unused codes remain valid until used or rotated.

## HTTP contract

All routes return `Cache-Control: no-store`. Use the normal API base URL. Personal calls use `credentials: include`, omit merchant/mode headers (`store:false` in the reference client), and send `Tendr-CSRF` on authenticated writes. API keys and restricted legacy recovery sessions cannot generate codes.

| Method and path                        | Authentication and body                                 | Response                                                                         |
| -------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /v1/auth/login-recovery/codes`    | Personal session                                        | `200 {enabled, remaining, generatedAt}`; ISO date or null; never plaintext codes |
| `POST /v1/auth/login-recovery/codes`   | Personal session, CSRF, recent passkey step-up; `{}`    | `200 {codes: string[], remaining: 10}`; display once                             |
| `POST /v1/auth/login-recovery/start`   | Public; `{email}`                                       | Generic `202 {ok:true}` for known, unknown or unprepared accounts                |
| `POST /v1/auth/login-recovery/options` | Public; `{token, recoveryCode}`                         | Standard SimpleWebAuthn registration options                                     |
| `POST /v1/auth/login-recovery/verify`  | Public; `{token, recoveryCode, response, deviceLabel?}` | `200 {recovered:true}`; session cookies cleared, no new session                  |

Use `startRegistration({optionsJSON})` for the options response, then submit its response unchanged to `/verify` with the same token/code. `deviceLabel` is optional, 1–64 trimmed characters. A canceled browser ceremony does not spend the code; retry with fresh options. Each new options request supersedes the previous challenge for that email link. Codes tolerate spaces, hyphens and letter case. Email tokens are 43-character base64url strings. Do not inspect or log WebAuthn attestation data in product UI.

The email link lasts 15 minutes. A registration challenge lasts at most five minutes and never beyond its link. Error handling: `401` invalid/expired/used link or code (do not distinguish the factors); `400` invalid input/attestation; `409` attempted reuse of an existing login/wallet key; `STEP_UP_REQUIRED` confirms the current login passkey; `429` respects `Retry-After`; `503` means recovery rate protection is temporarily unavailable. Mail-provider failures retain the generic accepted response and log a request ID without the secret; offer a retry if no email arrives. Responses are generic, not guaranteed identical in timing.

Redis limits within 15 minutes: start 10/IP and 3/email, options 20/IP and 10/token, verify 20/IP and 10/token. Rate protection fails closed. Normal gateway limits also apply.

## Security and emails

The database stores only domain-separated SHA-256 hashes of 128-bit random codes and hashes of 256-bit email tokens. Per-user row locks and final proof checks ensure one winner under concurrent requests. Recovery invalidates older auth email tokens and user-bound WebAuthn challenges. Normal registration rechecks the session under the same lock; login session creation rechecks the credential after assertion verification. A request that authenticated just before recovery cannot add a key with a revoked session or create a session with a revoked login key.

| Template                       | Payload                               | Trigger and design requirements                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_recovery_link`          | `url` ending `/recover/login#token=…` | Explicit request to a verified user with unused codes. Explain email + saved code, 15-minute deadline, old-key/session revocation and wallet limitation. Preserve the fragment; no tracking or automatic verification. |
| `login_recovery_codes_changed` | `at` (ISO), `url` to settings         | Codes generated/rotated; verified account email. Never include codes. Explain previous codes are invalid and how to review an unexpected change.                                                                       |
| `login_recovery_completed`     | `at` (ISO), `url` to settings         | Recovery completed; verified account email. Explain old login keys/sessions revoked, same account/wallet, and steps if unexpected.                                                                                     |

The last two messages use transactional events `user.login_recovery_codes.rotated` and `user.login_recovery.completed`, with outbox retry and event-notice deduplication. Their empty event payloads contain no secrets. Worker handler registration is required. See the updated synthetic [fixtures](email-design-fixtures.json) and [plain-text preview](email-preview.html); retain the HTML email shell already on `deploy`.

## Deployment and acceptance

Apply migration `20261111090000_login_recovery`, regenerate Prisma, and deploy API, worker and web together. It adds two identity tables only; no existing balances, keys or accounts are migrated. Existing users have no codes until they enroll. Keep `WEB_URL`, WebAuthn RP/origin, cookie and CORS settings consistent with the public frontend. Redis and mail delivery must be available. No new provider secret is required.

Required UI checks: first-passkey setup and optional skip, existing-user enrollment, save acknowledgment, regeneration warning, expired/invalid links, canceled passkey creation, rate limit/retry, successful recovery and new login, backup-key add/remove, and clear wallet-key limitations. The automated suite covers both factors, cross-user proof rejection, replay/concurrency, expiry, origin/RP/UV, historical/wallet-key reuse, stale sessions, unchanged wallets/memberships, alerts, scanner-safe UI and no browser secret storage.

Users without a saved code or another working login passkey cannot replace lost login keys through email alone. Synced passkeys and registered backup devices are the first fallback. Login recovery never grants access to an unavailable dedicated wallet signing key.
