# Payment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants create reusable payment links (fixed price or payer-chosen amount, optional note) at `usetendr.tech/pay/<merchant>/<link>`, with a QR code and a chat preview card; payers pay through the existing checkout.

**Architecture:** A `payment-links` module in the API owns link CRUD, availability and the public read/session-creation endpoints; session creation reuses `createSession` with a small internal extension (no `external_ref`, a payer note, link fee payer, availability checks). The web app gets a server-rendered link page, a QR route and an Open Graph image under the restructured `/pay` routes, and hands off to the unchanged `/pay/<session>` checkout.

**Tech Stack:** npm workspaces + Turbo (strict env), Node 22, TypeScript ESM, Fastify 5, Prisma 6 / Postgres 16, Redis + `@fastify/rate-limit`, zod, Next.js (app router, `next/og`), `qrcode`, Vitest, Playwright, Mintlify.

**Spec:** `docs/superpowers/specs/2026-10-30-payment-links-design.md` (approved 2026-10-30, commit 4cd461b).

## Global Constraints

- Never add a `Co-Authored-By` trailer or "Generated with Claude Code" line to commits.
- Never store secrets in Postgres; nothing deployed, nothing pushed; never touch the DB named `tendr` (dev DB is `tendr_foundation`, test DB `tendr_foundation_test`, Postgres on 5433, Redis 6380); install nothing on the host (Docker only).
- New env vars go in `turbo.json` (strict env mode).
- Every merchant-owned query goes through the scoped client (`scopedDb` / `req.db`); cross-merchant and cross-mode links are rejected by composite foreign keys.
- Link amounts: `USD` or an ISO 4217 code in `ISO_4217_MINOR_UNITS` (`apps/api/src/checkout/fx.ts`); never the settlement asset id.
- Open-amount floor: **$1.00 USD equivalent** (`LINK_MIN_USD = '1.00'`); a merchant `min_amount` may only raise it; all minimums apply to the link amount before fees.
- Payer note: ≤ **280** characters after cleaning; plain text; escaped wherever shown; links in it never made clickable.
- Title ≤ **80** chars; description ≤ **500** chars, plain text.
- Link slug: `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$` (3–60 chars), unique per `(merchant, livemode)`, **immutable** after creation; reserved: `refund-address`, `qr`, `opengraph-image`, `twitter-image`, `test`, `new`, `edit`.
- Test links are addressed with `?mode=test`; without it only live links resolve.
- Sessions are created only when the payer presses Pay — never on page load or preview fetch.
- Merchant slugs never change (set at signup, they are NEAR account labels — `apps/api/src/merchants/reserved-labels.ts`), so no redirect handling is needed (closes spec §10 item 2).
- Existing `/pay/<session id>` URLs and `/pay/<session id>/refund-address` must keep working unchanged.
- Domain: `usetendr.tech` only (settled in projects 2 and 4).
- `max_uses` is enforced at session creation: a link-row lock (`FOR UPDATE`), then `useCount + open sessions ≥ maxUses` → refuse (`LINK_RESERVED` 409 `Someone is paying this link right now, try again shortly.`, or `LINK_UNAVAILABLE`/`used_up` when all uses are settled). "Open" = status `PENDING_DEPOSIT` and `expiresAt > now`, or status `PROCESSING | SCREENING_PENDING` (no expiry condition: a payment in progress holds its use until it settles or fails).
- Link sessions start with `LINK_UNQUOTED_TTL_MS = 5 * 60_000`; the first quote extends `expiresAt` to `createdAt + SESSION_TTL_MS` in the quote's transaction.
- Fixed and open amounts both meet the $1.00 floor, checked at create/edit (fixed) and again at Pay (both).
- Public reads are limited **per payer IP**. The web server sends `x-tendr-internal: <WEB_INTERNAL_TOKEN>` and `x-tendr-client-ip: <payer ip>`. The API honours the IP header only with a valid token (constant-time compare), and then skips per-IP limits for the server's own address. `WEB_INTERNAL_TOKEN` is an env secret in both apps (≥ 32 chars, required in production) and goes in `turbo.json`.
- The OG image renderer fetches a logo only from `TENDR_ASSET_ORIGIN` (https, same origin, 3 s timeout, `redirect: 'error'`, ≤ 1 MB, `image/*`); otherwise it draws the merchant's initial.

## Review Focus

1. A payer types an open amount with too many decimals for the currency (e.g. `1000.555` NGN, or `5,000` with a comma) → a clear field error on the page, a 400 from the API, never a 500 or a silently rounded amount. (Task 4 test `rejects amounts with excess precision or separators`; Task 6 test `amount input rejects bad formats`.)
2. A link is switched off, archived, expired or used up between the page loading and the payer pressing Pay → the POST is refused with `LINK_UNAVAILABLE` and the page swaps to the matching unavailable state instead of erroring. (Task 4 `re-checks availability at press time`; Task 6 `shows unavailable state after a refused pay`.)
3. A note containing HTML, `<script>`, control characters, emoji or a URL → stored cleaned, appears escaped in the email text/data and webhook JSON, never as markup. (Task 4 `cleans the note`; Task 5 `escapes the note in the email`.)
4. FX provider down when a non-USD link is opened → the page still renders title and local amount with no USD line; Pay returns `FX_RATE_UNAVAILABLE` and the page says "try again in a minute". (Task 4 `public view without a rate`; Task 6 `renders without usd equivalent`.)
5. Two payers press Pay on a single-use invoice at the same instant → exactly one gets a session; the other sees "Someone is paying this link right now, try again shortly." (Task 4 `concurrent pay on max_uses 1 creates one session`.) One attacker hammering a link's public read can't take it offline for other payers, because limits are per payer IP via the web server's trusted header. (Task 4 `public read limited per payer IP via internal header`.)

---

### Task 1: Schema and shared contracts

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`PaymentLink` ~925, `Session` ~960)
- Create: `apps/api/prisma/migrations/20261030100000_payment_links/migration.sql`
- Create: `packages/contracts/src/payment-links.ts`, `packages/contracts/src/payment-links.test.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/db/schema.test.ts`, `apps/api/src/merchants/reserved-labels.ts` (+ its test)

**Interfaces:**
- Produces (Prisma `PaymentLink` additions): `description String?`, `minAmount Decimal? @db.Decimal(38,18) @map("min_amount")`, `noteMode PaymentLinkNoteMode @default(optional) @map("note_mode")` with enum `PaymentLinkNoteMode { off optional }`, `feePayer FeePayer? @map("fee_payer")` (reuse the existing session fee-payer enum; null = merchant default), `archivedAt DateTime? @map("archived_at")`; **drop** `destAsset`, `destChain`. `amount_currency` keeps its column.
- Produces (Prisma `Session`): `payerNote String? @map("payer_note") @db.VarChar(280)`.
- Produces (`@tendr/contracts`): constants `LINK_MIN_USD = '1.00'`, `PAYER_NOTE_MAX = 280`, `LINK_TITLE_MAX = 80`, `LINK_DESCRIPTION_MAX = 500`, `LINK_SLUG_RE`, `RESERVED_LINK_SLUGS`; `PaymentLinkAvailabilitySchema = z.enum(['available','inactive','archived','expired','used_up','merchant_not_ready'])`; `PaymentLinkCreateSchema` (`title`, `description?`, `slug?`, `amount_type: 'fixed'|'open'`, `amount?`, `currency`, `min_amount?`, `note: 'off'|'optional'` default `optional`, `status?: 'active'|'inactive'`, `expires_at?` ISO, `max_uses?` int ≥1, `fee_payer?`, `gas_payer?`, `gas_max_usd?`) with refinements: `amount` required iff `fixed`, `min_amount` only for `open`; `PaymentLinkUpdateSchema` = create minus `slug`, all optional, plus `archived?: boolean`; `PublicLinkSessionInputSchema` (`amount?: string`, `note?: string ≤ 2000 raw`); type `PublicPaymentLinkView` (§Task 4); `cleanPayerNote(raw: string | undefined): string | null`.

- [ ] **Step 1: Write failing contracts tests** in `payment-links.test.ts`:
  - `rejects fixed links without amount and open links with amount`;
  - `rejects min_amount on fixed links`;
  - `slug rule`: `'ab'`, `'-ab'`, `'ab-'`, `'Ab1'`, 61 chars → invalid; `'tithe'`, `'sunday-offering-2'` → valid; every `RESERVED_LINK_SLUGS` entry rejected by `PaymentLinkCreateSchema`;
  - `cleanPayerNote`: `'  hi\u0000\u0007 there  '` → `'hi there'`; `'\n\t'` → `null`; 300 × `'a'` → length 280; `'<b>x</b>'` unchanged (escaping happens at render); emoji kept intact (never split a surrogate pair at the 280 cut).
- [ ] **Step 2:** `npx vitest run --root packages/contracts src/payment-links.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the contracts module; export from `index.ts`. `cleanPayerNote` removes `\p{Cc}`, collapses whitespace runs to one space, trims, truncates by code points to 280, returns `null` when empty.
- [ ] **Step 4:** Edit the Prisma schema and write the migration by hand (`prisma migrate diff` to draft, then check it): new enum + columns, drop the two link columns, add `sessions.payer_note`. Add to `schema.test.ts`: `payment_links has no dest_asset column` and `sessions.payer_note is varchar(280)`.
- [ ] **Step 4b:** In `reserved-labels.ts` `PREFIXES`, add `'ses_'` and `'ses-'` (a merchant slug must never look like a session id under `/pay/[id]`). Tests: `isReservedLabel('ses_01jabc')` and `isReservedLabel('ses-01jabc')` → true; `slugBase('ses_01J9ZK')` never returns a value starting with `ses_` (signup maps `_` to `-`, then `ses-` is reserved, so it maps to `store-…`).
- [ ] **Step 5:** `npm run db:migrate:test --workspace=@tendr/api && npx vitest run --root apps/api src/db/schema.test.ts src/merchants && npx turbo run typecheck` → PASS. Fix every compile error from the dropped columns (seed, `test/helpers.ts` `createRow('PaymentLink', …)` defaults).
- [ ] **Step 6: Commit** `feat(db): payment link fields, payer note; shared link contracts`.

### Task 2: Link service (create, read, update, archive, availability, totals)

**Files:**
- Create: `apps/api/src/payment-links/links.ts`, `apps/api/src/payment-links/links.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; `readinessFor(ctx)` from `checkout/sessions.ts` (export it if not exported); `minorUnits`, `assertAmount`-style precision check from `checkout/fx.ts` / `sessions.ts` (reuse, don't copy).
- Produces:
  - `type LinkCtx = { merchantId: string; livemode: boolean; db: ScopedDb }`
  - `createLink(ctx, input: PaymentLinkCreate): Promise<PaymentLinkView>`
  - `listLinks(ctx, q: { status?: 'active'|'inactive'; include_archived?: boolean; limit: number; starting_after?: string }): Promise<{ data: PaymentLinkView[]; has_more: boolean }>`
  - `getLink(ctx, id): Promise<PaymentLinkView>` (with totals), `updateLink(ctx, id, input)`, `archiveLink(ctx, id)`
  - `linkAvailability(link, opts: { now: Date; merchantReady: boolean }): PaymentLinkAvailability` — order of checks: archived → inactive → expired → used_up → merchant_not_ready → available.
  - `linkUrls(merchantSlug, linkSlug, livemode): { url: string; qr_url: string }` using the web base URL env already used for hosted checkout (`hostedUrl`'s base); test adds `?mode=test` (QR: `/qr?mode=test`).
  - `PaymentLinkView`: `{ id, object: 'payment_link', livemode, title, description, slug, url, qr_url, amount_type, amount, currency, min_amount, note, fee_payer, gas_payer, gas_max_usd, status, archived, availability, expires_at, max_uses, use_count, total_paid, total_refunded, total_paid_usd, total_refunded_usd, created_at, updated_at }`. `total_paid`/`total_refunded` are decimal strings in the link's `currency`, `*_usd` in USD.
  - `assertAboveFloor(amount: string, currency: string, now: Date): Promise<void>`: converts with the existing FX service and throws `AMOUNT_TOO_LOW` (400, `details.min_amount` = the $1 floor in `currency`, rounded **up** to minor units) when the amount is below $1.00. FX failure throws `FX_RATE_UNAVAILABLE`. Used by `createLink`/`updateLink` for fixed amounts, and by Task 4 at Pay.

- [ ] **Step 1: Failing tests** (`links.test.ts`, real test DB, helpers from `test/helpers.ts`):
  - `creates a fixed NGN link with a generated slug` (title "Sunday Offering" → `sunday-offering`; second → `sunday-offering-2`… or a short random suffix — assert unique and matches `LINK_SLUG_RE`);
  - `same slug allowed in test and live mode`;
  - `rejects unsupported currency and the settlement asset id` (`UNSUPPORTED_CURRENCY`);
  - `rejects amounts with excess precision for the currency` (`'10.001'` USD; `'5.5'` JPY);
  - `refuses links for integrator merchants with contract payout` (error code `LINK_NOT_SUPPORTED`, 409);
  - `slug cannot be changed by update` (schema strips/refuses `slug`; assert 400);
  - `availability`: archived beats expired; `expires_at` in the past → `expired`; `use_count >= max_uses` → `used_up`; no active account → `merchant_not_ready`; otherwise `available`;
  - `archive hides from default list; include_archived shows it; PATCH archived:false restores`;
  - `totals`: two link sessions with a settled payment (session amounts `10.00`, `5.50` USD), one pending → `total_paid_usd = '15.50'`; an executed merchant refund of half the first payment's `amountOut` → `total_refunded_usd = '5.00'`;
  - `NGN totals are in naira and in USD`: NGN link, two settled sessions with `originalAmount` `50000` / `25000` NGN and `amount` `31.25` / `15.63` USD → `total_paid = '75000.00'`, `total_paid_usd = '46.88'`; a half refund of the first → `total_refunded = '25000.00'`, `total_refunded_usd = '15.63'` (round half-up to minor units);
  - `fixed link below the $1 floor is refused` (stub rate 1 USD = 1600 NGN: fixed `1000` NGN → `AMOUNT_TOO_LOW` with `details.min_amount = '1600.00'`; `1600` → created); `FX down refuses a non-USD fixed link` (`FX_RATE_UNAVAILABLE`); the same checks on `updateLink` when `amount` changes;
  - `another merchant's link is NOT_FOUND`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Totals over the link's sessions that have a payment with `settledAt` not null. `session.amount` is already USD for non-USD links (`originalAmount` holds the local figure), so: `total_paid_usd` = Σ `session.amount`, and `total_paid` = Σ (`originalAmount ?? amount`). Refunds: over merchant refunds (`reason = merchant`, the executed status `merchant-refunds.ts` treats as done), share = `refund.amount / payment.amountOut`. `total_refunded_usd` = Σ share × `session.amount` (cents); `total_refunded` = Σ share × (`originalAmount ?? amount`) (currency minor units). `expired` is computed, never persisted (*ruling: computed on read*).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(api): payment link service with availability and totals`.

### Task 3: Merchant API routes

**Files:**
- Create: `apps/api/src/routes/payment-links.ts`, `apps/api/src/routes/payment-links.test.ts`
- Modify: `apps/api/src/app.ts` (register)

**Interfaces:**
- Consumes: Task 2 functions.
- Produces: `POST /v1/payment_links` (201), `GET /v1/payment_links`, `GET /v1/payment_links/:id`, `PATCH /v1/payment_links/:id`, `DELETE /v1/payment_links/:id` (archive, returns the view).
- Auth (pattern of `routes/gas.ts`): principals `dashboard_user` + `secret_key`; keys need scope `payment_links:read` / `payment_links:write`; dashboard users need `account:read` to read and `money:request` to write (*ruling: a link requests money; finance role can make them; no step-up*).

- [ ] **Step 1: Failing route tests:** create→get→patch→delete round trip with a test key; `read-only key cannot write` (403); `viewer cannot create, finance can`; `Idempotency-Key replays the same link`; `test key cannot see live links`; `unknown field rejected` (400).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and register. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(api): /v1/payment_links merchant API`.

### Task 4: Sessions from links and the public endpoints

**Files:**
- Modify: `apps/api/src/checkout/sessions.ts`, `apps/api/src/checkout/watcher.ts:~1382`, `apps/api/src/checkout/quotes.ts` (session client view; first-quote expiry extension), `apps/api/src/checkout/payment-views.ts` (list filter), `apps/api/src/gateway/rate-limit.ts`, `apps/api/src/app.ts`, `apps/api/src/env.ts` (+ `env.test.ts`), `turbo.json`, `.env.example`
- Create: `apps/api/src/gateway/internal-client.ts` (+ test)
- Create: `apps/api/src/payment-links/public.ts`, `apps/api/src/routes/payment-links-public.ts`, tests beside each
- Modify tests: `apps/api/src/routes/checkout-sessions.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `createSession(ctx, input, opts?: { fromLink?: { linkId: string; payerNote: string | null; returnUrl: string } })` — when `fromLink` is set: `external_ref` may be absent (schema-level `external_ref` stays required for the store route; the public path builds a `CreateSessionInput` with a placeholder-free internal type — *ruling: add `InternalSessionInput = Omit<CreateSessionInput,'external_ref'|'success_url'|'cancel_url'> & { external_ref?: string; success_url: string; cancel_url: string }`*), `payerNote` is stored, `success_url` and `cancel_url` = `returnUrl`.
  - For **every** session naming a link (store route included), inside the session-insert transaction: `SELECT … FROM payment_links WHERE id = $1 AND merchant_id = $2 AND livemode = $3 FOR UPDATE` (raw query on the transaction client), then compute `linkAvailability`; anything but `available` → `LINK_UNAVAILABLE` (409, `details.availability`). When `maxUses` is set, count open sessions for the link (Global Constraints definition). If `useCount + open ≥ maxUses` → `LINK_RESERVED` (409) when `open > 0`, else `LINK_UNAVAILABLE`/`used_up`. Link `feePayer` joins `resolvePayers` (replace the "no fee-payer setting yet" comment).
  - Link sessions created through the public path get `expiresAt = now + LINK_UNQUOTED_TTL_MS`. In `quotes.ts`, the quote-insert transaction runs `session.updateMany({ where: { id, paymentLinkId: { not: null }, quotes: { none: {} } }, data: { expiresAt: createdAt + SESSION_TTL_MS } })` before inserting, so only the first quote extends it. Store-path sessions naming a link keep the caller's expiry.
  - Stale-session sweep runs only when `external_ref` is present (spec §10).
  - Watcher: inside the SETTLED transaction, `if (s.paymentLinkId) paymentLink.updateMany({ where: { id, merchantId, livemode }, data: { useCount: { increment: 1 } } })`.
  - `getPublicLink(merchantSlug, linkSlug, livemode): Promise<PublicPaymentLinkView>`:
    `{ merchant: { name, logo_url }, title, description, amount_type, amount, currency, min_amount /* effective: max(link min, $1 floor in currency, rounded UP to minor units) — open only */, usd_rate: string | null /* 1 USD = X currency; null for USD or when FX unavailable */, note: 'off'|'optional', fee_payer: 'merchant'|'shopper', availability /* archived reported as 'inactive' */, livemode }`. Unknown merchant or link → `NOT_FOUND` with the same message for both.
  - `createLinkSession(merchantSlug, linkSlug, livemode, input: PublicLinkSessionInput, ip): Promise<{ url: string }>`. Fixed links ignore `amount` and re-run `assertAboveFloor` (Task 2) at the current rate. Open links validate precision (`AMOUNT_RE`, no separators) and require `amount >= effective min`, else `AMOUNT_TOO_LOW` (400, `details.min_amount`). It cleans the note (dropped when `note = 'off'`). It refuses with `LINK_BUSY` (429) when the link has ≥ `LINK_MAX_QUOTED_SESSIONS = 200` open sessions **that have at least one quote**.
  - `internalClient(req): { trusted: boolean; clientIp: string }` (`gateway/internal-client.ts`). It is trusted only when `x-tendr-internal` equals `env.WEB_INTERNAL_TOKEN` (`timingSafeEqual` on equal-length buffers; unset token → never trusted). When trusted and `x-tendr-client-ip` is a valid IPv4/IPv6 literal (`net.isIP`), `clientIp` is that header; otherwise it is `req.ip`. The rate-limit hook uses `clientIp` for every per-IP key and **skips `ip_global` and `public` for trusted requests** (the global ceilings still count them).
  - Env: `WEB_INTERNAL_TOKEN` (optional; required with `.min(32)` when `NODE_ENV=production`, following the existing pattern in `env.ts`); add to `turbo.json` and `.env.example`.
  - Routes (`auth: 'public', publicLimit: 'route'`):
    - `GET /v1/payment_links/public/:merchant/:link`: limiter `payment_link_read` **120/min per payer IP**, plus `payment_link_read_global` 20000/min.
    - `POST /v1/payment_links/public/:merchant/:link/sessions`: limiters `payment_link_session` **10/min per IP** and `payment_link_session_link` **3 per (IP, link) per 5 min**.
    - `?mode=test` selects test mode; both send `cache-control: no-store`.
  - Session client view (`quotes.ts` view) gains `payment_link: { title: string; url: string } | null`; store `sessionView` gains `payer_note`.
  - `PaymentListQuerySchema` gains `payment_link_id`.

- [ ] **Step 1: Failing tests:**
  - store route: `refuses a session for a switched-off link` (409 `LINK_UNAVAILABLE`), `uses the link fee payer`, `sweep does not expire other sessions when external_ref is absent`;
  - watcher: `increments use_count once when a link session settles`, `used_up after max_uses settled`;
  - public: `public view hides ids, limits and counts` (assert exact key set), `unknown merchant and unknown link give the same 404`, `test link needs mode=test`, `effective min is the $1 floor in NGN rounded up` (fixed test rate), `public view without a rate` (FX stub throws → `usd_rate: null`, 200);
  - create: `fixed link ignores posted amount`, `rejects amounts with excess precision or separators` (`'1000.555'` NGN, `'5,000'`), `AMOUNT_TOO_LOW below min`, `cleans the note`, `drops the note when the link has note off`, `re-checks availability at press time` (archive between read and POST → 409), `fixed link below the floor at press time` (rate moves after creation → `AMOUNT_TOO_LOW`), `returns the hosted url with #cs= and the session has no external_ref`;
  - reservation: `concurrent pay on max_uses 1 creates one session` (two `createLinkSession` calls via `Promise.all` → one `{url}`, one `LINK_RESERVED`); `reservation freed when the session expires` (expire it → next Pay succeeds); `all uses settled → LINK_UNAVAILABLE used_up`; `store-path session naming a max_uses link also reserves`;
  - TTL and busy: `link session starts with a 5-minute expiry`; `first quote extends expiry to createdAt + SESSION_TTL_MS, second quote does not change it`; `unquoted sessions do not count toward LINK_BUSY` (200 unquoted → Pay still succeeds); `LINK_BUSY at 200 quoted open sessions`;
  - limits: `public read limited per payer IP via internal header` (with the token, 121 reads carrying `x-tendr-client-ip: 203.0.113.7` → 429; a read carrying `203.0.113.8` → 200); `client ip header ignored without a valid token` (a wrong or missing token → keyed on `req.ip`); `invalid client ip header falls back to req.ip`; `session create limited per IP and per IP per link`;
  - env: `WEB_INTERNAL_TOKEN required and ≥ 32 chars in production`;
  - list: `payments list filters by payment_link_id`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, plus the whole API suite (`npx turbo run test --filter=@tendr/api`) because `createSession` changed.
- [ ] **Step 5: Commit** `feat(api): sessions from payment links, public link endpoints, use counting`.

### Task 5: Merchant notifications (webhooks and the "You got paid" email)

**Files:**
- Modify: `apps/api/src/checkout/webhooks.ts` (`DATA_KEYS`, `webhookData`), `apps/api/src/checkout/watcher.ts` and `apps/api/src/checkout/sessions.ts` event payloads, `apps/api/src/jobs/payment-notices.ts`
- Create: `apps/api/src/checkout/session-refs.ts`
- Tests: `checkout/webhooks.test.ts`, `jobs/payment-notices.test.ts` (or the existing notices test file)

**Interfaces:**
- Produces: `sessionRefs(s: { externalRef: string | null; paymentLinkId: string | null; payerNote: string | null }): { external_ref: string | null; payment_link_id: string | null; payer_note: string | null }` — used at **every** event payload site that writes `external_ref` from a session today (grep `external_ref: s.externalRef` and `external_ref: input.external_ref` in `watcher.ts`, `sessions.ts`, refunds); `DATA_KEYS` gains `payment_link_id`, `payer_note`; `webhookData` defaults both to `null` whenever `session_id` is present (like `external_ref`).
- Email: when the session has a link, subject `You got paid <received> via <link title>`; body first line `<store> received <received> via <link title>.`, then a `Note from the payer:` block with the note as quoted plain text (`> ` prefix per line) when present; `data` gains `payment_link_title`, `payer_note`. Non-link payments unchanged.

- [ ] **Step 1: Failing tests:** `payment.succeeded webhook carries payment_link_id and payer_note`; `non-link session events carry both as null`; `webhook body is identical across attempts` (unchanged); `link payment email names the link and quotes the note`; `escapes the note in the email` (note `<script>x</script> http://evil.example` appears verbatim as text in `text`, and `data.payer_note` is the raw string — the email renderer must treat it as text; if an HTML template exists, assert the escaped form there).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Confirm the WooCommerce plugin ignores unknown webhook keys: read `apps/woocommerce/includes/class-tendr-webhooks.php`; if it rejects unknown keys, add a PHP test and fix; otherwise record "ignores unknown keys" in the report. Run `npx turbo run test --filter=@tendr/woocommerce` if a PHP change was made (Docker per the plugin's README).
- [ ] **Step 6: Commit** `feat(api): payment link and payer note in webhooks and payment emails`.

### Task 6: The payer's link page

**Files:**
- Move: `apps/web/src/app/pay/[sessionId]/` → `apps/web/src/app/pay/[id]/` (update params and imports; keep `SESSION_ID` checks)
- Create: `apps/web/src/app/pay/[id]/[link]/page.tsx`, `apps/web/src/app/pay/[id]/[link]/LinkPay.tsx` (client), `apps/web/src/lib/payment-links.ts` (+ tests)
- Modify: `apps/web/src/app/pay/[id]/components/StatusScreens.tsx` (back link), `apps/web/src/middleware.ts` (+ test), `apps/web/e2e/` (new `payment-links.spec.ts`)

**Interfaces:**
- Consumes: Task 4 public endpoints and `payment_link` on the session client view.
- Produces: `fetchPublicLink(merchant, link, test: boolean, payerIp: string | null): Promise<PublicPaymentLinkView | null>` (server-only module, `serverEnv.apiBaseUrl`, `cache: 'no-store'`, sends `x-tendr-internal: WEB_INTERNAL_TOKEN` and `x-tendr-client-ip` when `payerIp` is set). `payerIpFrom(h: Headers): string | null` takes the **rightmost** `x-forwarded-for` entry (one trusted proxy hop, matching the API's `trustProxy`) and returns null when it isn't a valid IP. The token never reaches client bundles: add `WEB_INTERNAL_TOKEN` to the web's server env and `turbo.json`, and test that `publicEnv` has no such key. `startLinkPayment(merchant, link, test, { amount?, note? }): Promise<{ url } | { error: { code; message; details? } }>` (browser, public API base URL).
- Page: server-rendered per the approved mockup (`.superpowers/brainstorm/42933-1793110793/content/payment-link-pages-v2.html`): header (logo + display name), title, description (plain text, line breaks kept, no autolinking), amount (fixed: local + `≈ $X.XX` from `usd_rate`; open: amount input in the link currency, `Minimum <formatted>` line, live USD equivalent), note input when `note = 'optional'` with label `Note to <merchant> (optional)`, maxlength 280, `plus fees, shown before you pay` under the amount when `fee_payer = 'shopper'`, button `Pay with crypto`, and the test-mode banner `Test mode — no real money moves` when `livemode` is false. Unavailable copy: inactive/archived `This link isn't taking payments right now`, expired `This link has expired`, used_up `This link isn't taking payments right now`, merchant_not_ready `This link isn't taking payments yet`, not found → Next `notFound()`.
- On Pay: POST, then `window.location.assign(url)`. Error handling:
  - `LINK_UNAVAILABLE` → swap to the unavailable state.
  - `LINK_RESERVED` → `Someone is paying this link right now, try again shortly.` (button stays enabled).
  - `AMOUNT_TOO_LOW` → for open links, a field error with the minimum; for fixed links, `This amount is too small to pay in crypto right now.` and no button.
  - `LINK_BUSY` / 429 → `Too many people are paying right now. Try again in a minute.`
  - `FX_RATE_UNAVAILABLE` → `Prices can't be loaded right now. Try again in a minute.`
- Success screen: when `view.payment_link` is set, the success/cancel links read `Back to <title>` and go to `payment_link.url` instead of "Return to store".
- Middleware: `/pay/<m>/<l>/qr` and the OG image routes are exempt from `Cache-Control: no-store` (Task 7 sets their own caching); link pages stay `no-store`.

- [ ] **Step 1: Failing unit tests** (`lib/payment-links.test.ts`, component tests with the existing testing setup): `amount input rejects bad formats` (`'5,000'`, `'1.2.3'`, too many decimals for NGN/JPY); `renders without usd equivalent` (`usd_rate: null` → no `≈` line); `shows unavailable state after a refused pay`; `shows plus-fees line only for shopper-paid links`; `shows the someone-is-paying message on LINK_RESERVED`; `payerIpFrom takes the rightmost forwarded entry and rejects junk`; `fetchPublicLink sends the internal headers`; `/pay/ses_<valid id> still routes to the session page`; middleware test `qr route not forced no-store; link page is`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Move the session route, then build the page. **Step 4:** `npx turbo run typecheck lint test --filter=@tendr/web` → PASS; the existing `e2e/checkout.spec.ts` still passes (session URLs unchanged).
- [ ] **Step 5: E2E** `e2e/payment-links.spec.ts` (test mode, existing e2e fixtures): create an open NGN link via the API, open `/pay/<merchant>/<link>?mode=test`, enter an amount and a note, Pay, land on `/pay/<ses>`, simulate the deposit with the test controls, see success with `Back to <title>`; the merchant's webhook fixture received `payer_note`. Run it → PASS.
- [ ] **Step 6: Commit** `feat(web): payment link page and back-to-link success screen`.

### Task 7: QR code and preview card

**Files:**
- Create: `apps/web/src/app/pay/[id]/[link]/qr/route.ts`, `apps/web/src/app/pay/[id]/[link]/opengraph-image.tsx` (and `twitter-image.tsx` re-exporting it), `apps/web/src/lib/og-logo.ts`, tests
- Modify: `apps/web/src/app/pay/[id]/[link]/page.tsx` (`generateMetadata`)

**Interfaces:**
- Consumes: `fetchPublicLink` (Task 6), `apps/web/src/lib/qr.ts`.
- QR: `GET /pay/<m>/<l>/qr[?mode=test][&format=svg]` → PNG (default, 1024 px, margin 4 modules, error correction `M`) or SVG of the link URL (with `?mode=test` for test links); 404 when the link doesn't exist; `Cache-Control: public, max-age=300` (*ruling: short cache; a link's URL never changes but deletion should show within minutes*).
- Metadata: `og:title` = link title, `og:description` = `<merchant> · <price or "Pay any amount">` (test links prefix `Test · `), `og:image` from `opengraph-image.tsx` (1200×630, `next/og` `ImageResponse`: logo, merchant name, title, price or "Pay any amount"; inactive/expired/used up → no price). Image `Cache-Control: public, max-age=300`.
- Logo: `safeLogo(url: string | null): Promise<ArrayBuffer | null>` in `apps/web/src/lib/og-logo.ts`. It returns null unless `TENDR_ASSET_ORIGIN` is set, the URL parses, the protocol is `https:` and `new URL(url).origin === TENDR_ASSET_ORIGIN`. It fetches with `AbortSignal.timeout(3000)` and `redirect: 'error'`, requires an `image/*` content type, and stops reading past 1 MB. Any failure → null, and the card draws the merchant's initial in a circle. Add `TENDR_ASSET_ORIGIN` to the web server env and `turbo.json`. QR and OG routes pass `payerIpFrom(headers())` to `fetchPublicLink`.

- [ ] **Step 1: Failing tests:** `qr route returns png and svg encoding the link url`; `qr for a test link encodes ?mode=test`; `qr 404 for unknown link`; `metadata for fixed, open, test and inactive links` (assert title/description strings); `safeLogo` refuses `http://` URLs, other origins, `https://<asset origin>.evil.example`, `http://169.254.169.254/`, and URLs when `TENDR_ASSET_ORIGIN` is unset, all **without calling fetch** (spy asserts zero calls); it returns null on redirect, non-image content type or > 1 MB.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; manually fetch the OG image in dev and view it (`curl -o /tmp/og.png …` then open) — attach the path in the report.
- [ ] **Step 5: Commit** `feat(web): payment link QR codes and preview cards`.

### Task 8: Docs, SDK and handover

**Files:**
- Create: `apps/docs/payment-links/overview.mdx`, `apps/docs/api-reference/payment-links.mdx`, `docs/handover/2026-10-30-payment-links.md`
- Modify: `apps/docs/docs.json`, `apps/docs/api-reference/webhooks.mdx` (new `payment_link_id`, `payer_note` keys), `packages/sdk/src/client.ts` (+ test), `README.md` (short "Payment links" section)

**Interfaces:**
- SDK: `client.paymentLinks.create(input)`, `.list(q?)`, `.retrieve(id)`, `.update(id, input)`, `.archive(id)` on top of the existing request helper, typed with `@tendr/contracts`; test against a mocked fetch asserting method, path and body.

- [ ] **Step 1:** SDK failing test → implement → pass.
- [ ] **Step 2:** Write the guide (kinds of link, currencies and the $1 minimum, who pays fees, the note, test mode and `?mode=test`, QR and preview cards, archive vs switch off, how `max_uses` reserves a use per open session (safe for single-use invoices) and the late-deposit caveat, unquoted sessions lapsing after 5 minutes, refunds don't free a use, totals in the link's currency and in USD, links refused for contract-payout integrators, what the payer sees) and the API reference for every Task 3 and Task 4 endpoint with errors (`LINK_UNAVAILABLE`, `LINK_RESERVED`, `AMOUNT_TOO_LOW`, `LINK_BUSY`, `LINK_NOT_SUPPORTED`, `FX_RATE_UNAVAILABLE`). The handover note documents `WEB_INTERNAL_TOKEN` and `TENDR_ASSET_ORIGIN` as deploy-time settings.
- [ ] **Step 3:** Handover note: how the API, public endpoints, limits, QR and preview routes work; *suggested* screens only (link list with totals, create/edit with live preview, link detail with QR download and copy link, payments filtered by link) — no screen-to-API mapping.
- [ ] **Step 4:** `npx turbo run typecheck lint test --concurrency=1` → all green. Mintlify broken-links check stays on the live checklist.
- [ ] **Step 5: Commit** `docs: payment links guide, API reference, SDK methods and handover note`.
