# Payment links: handover note

Scope: how the payment link APIs and infrastructure work, so the dashboard can be built on them.
Spec: `docs/superpowers/specs/2026-10-30-payment-links-design.md`. Public docs: `apps/docs/payment-links/`
and `apps/docs/api-reference/payment-links.mdx`.

Section 1 and 2 are how the system works. Section 3 is suggestion only: it does not map screens to
endpoints, and the dashboard team is free to shape the product differently.

## 1. How it works

### Merchant API (`apps/api/src/routes/payment-links.ts`)

`POST|GET /v1/payment_links`, `GET|PATCH|DELETE /v1/payment_links/:id`.

- **Principals.** A secret key (scopes `payment_links:read` / `payment_links:write`) or a dashboard
  user (`account:read` to read, `money:request` to write; no step-up). Everything goes through the
  scoped client, so a merchant never sees another merchant's or the other mode's links. A link's
  `(merchant, livemode)` is enforced by composite foreign keys.
- **Bodies are strict** (`packages/contracts/src/payment-links.ts`). Unknown keys are a 400. `slug` is
  settable on create only; on update it is a 400.
- **PATCH nulls.** `null` clears `expires_at`, `max_uses`, `description`, `min_amount`, `fee_payer`,
  `gas_payer`, `gas_max_usd`. An omitted key is unchanged. `archived: true|false` archives or restores.
  `DELETE` is the same as `archived: true` and returns the link.
- **Currency change.** A fixed link's `currency` change needs `amount` in the same PATCH (400
  `VALIDATION_ERROR`, field `amount`); an open link's `min_amount` is cleared unless supplied. The $1.00
  floor runs on the new values.
- **Slug.** Optional on create; generated from the title (`title`, `title-2`, ...) and retried on a race.
  3 to 60 chars, unique per store and mode, reserved words refused.
- **Amounts.** `USD` or an ISO 4217 code in the FX table. Minimum $1.00 USD equivalent on the amount
  before fees (`LINK_MIN_USD`); a merchant `min_amount` can only raise it. Fixed amounts are checked
  on create/edit and again on Pay.
- **Availability** is computed on every read, never stored: `archived`, `inactive`, `expired`,
  `used_up`, `merchant_not_ready`, `available`, checked in that order.
- **Totals** (`total_paid`, `total_refunded` in the link currency, `*_usd` in USD) are computed per
  read from settled payments and confirmed merchant refunds. `use_count` is a stored counter of
  settled sessions.
- **Not for contract payouts.** A merchant of kind `integrator` with payout mode `wallet` gets
  `LINK_NOT_SUPPORTED` (409).
- **URLs.** `url` and `qr_url` are built from `CHECKOUT_BASE_URL` (test links get `?mode=test`).
- **Filtering payments.** `GET /v1/payments?payment_link_id=<id>` returns the payments of one link.

### Public API (`payment-links-public.ts`, `payment-links/public.ts`)

No credential, never cached (`cache-control: no-store`, errors too).

- `GET /v1/payment_links/public/:merchant/:link[?mode=test]` returns `PublicPaymentLinkView`: merchant
  name and logo (from the published checkout theme), title, description, amount or open-amount
  minimum, `currency`, `minor_units`, `usd_rate`, `note`, `fee_payer`, `availability`, `livemode`.
  No ids, use counts or limits. An archived link reads as `inactive`. An unknown store, a store that
  cannot trade and an unknown link give the same 404.
- `POST .../sessions` (`{ amount?, note? }`) is "Pay". It re-checks availability, prices the amount
  (floor at the current rate), cleans the note (max 280 chars, plain text), and creates a normal
  checkout session with the link page as its return address. Response `201 { url, expires_at }` with
  the client secret in the URL fragment. The page keeps `{ url, expires_at }` in `sessionStorage`
  (per store, link and mode) and offers "Continue your payment" while it has not expired, so a payer
  who comes back is not blocked by their own reservation. Sessions are created only here, never on page load or preview.
- **Errors**: `NOT_FOUND`, `VALIDATION_ERROR`, `AMOUNT_TOO_LOW` (`details.min_amount`),
  `FX_RATE_UNAVAILABLE` (503), `LINK_UNAVAILABLE` (`details.availability`), `LINK_RESERVED` (409),
  `LINK_BUSY` (429), `LINK_NOT_SUPPORTED`, `RATE_LIMITED`.

### Sessions, `max_uses` and expiry (`apps/api/src/checkout/sessions.ts`)

- Session creation takes a **row lock** on the link (`FOR UPDATE`), then refuses unless the link is
  available. With `max_uses`, `use_count + open sessions >= max_uses` refuses: `LINK_RESERVED` while
  some uses are only held by open sessions, `LINK_UNAVAILABLE`/`used_up` when all are settled. "Open"
  means status `PENDING_DEPOSIT` with `expiresAt > now`, or status `PROCESSING` or `SCREENING_PENDING`
  whatever the expiry (a payment in progress holds its use until it settles or fails).
- Public sessions start with a **5 minute expiry** (`LINK_UNQUOTED_TTL_MS`). The first quote extends it
  to the normal lifetime in the quote's transaction. Sessions your server creates with
  `payment_link_id` keep the caller's expiry and `external_ref`.
- A public session is refused with `LINK_BUSY` when the link already has **200 open sessions with a
  quote**.
- **Late deposits** (after a session is marked expired) are refunded and never count as a use.
  Refunds never free a use. `use_count` can exceed `max_uses` only when a session past its expiry but
  not yet swept receives a deposit that settles (including a deposit in the very millisecond the
  session expires, after its use was released).

### Rate limits and the web server's identity

The public routes sit behind the web app, so the API sees the web server's address, not the payer's.
The web server sends `x-tendr-internal: <WEB_INTERNAL_TOKEN>` and `x-tendr-client-ip: <payer IP>`. The
API trusts the IP header only when the token matches (constant-time compare), and only on `GET`
requests under `/v1/payment_links/public/` (the read the web server makes). There it skips `ip_global`
for the web server's own address and keys the read limit on the payer's IP. Every other route,
including "Pay" (the payer's browser calls it directly), ignores both headers and keys on `req.ip`.

| Limit | Value |
| --- | --- |
| Public read | 120 per minute per payer IP, plus a 20 000 per minute ceiling over all payers |
| Pay | 10 per minute per payer IP, and 3 per payer IP per link per 5 minutes |

Without a valid token the header is ignored and the caller's own address is limited.

### Web routes (`apps/web/src/app/pay/[id]/[link]/`)

`/pay/<merchant>/<link>[?mode=test]`. `[id]` is the merchant slug here and the session id on the
existing `/pay/<session id>` URLs, which keep working unchanged, as does `/refund-address`.

- **Page** (`page.tsx`, `LinkPay.tsx`): server-rendered from the public read; Open Graph and Twitter
  tags point at the image routes below, with the same mode.
- **QR** (`qr/route.ts`): PNG 1024 px by default, `?format=svg` for SVG. Error correction M, 4-module
  quiet zone. Encodes `CHECKOUT_BASE_URL/pay/<merchant>/<link>` plus `?mode=test` when relevant.
  404 for an unknown link. `cache-control: public, max-age=300`.
- **Preview card** (`opengraph-image/route.tsx`, `twitter-image`): 1200 x 630 PNG. Draws the merchant
  logo only if `safeLogo` accepts it (`og-logo.ts`): same origin as `TENDR_ASSET_ORIGIN`, https,
  3 s timeout, no redirects, at most 1 MB, `image/*`. Otherwise it draws the merchant's initial.
  Cached 5 minutes.
- The web app talks to the API through `apps/web/src/lib/payment-links.ts`, which sends the internal
  headers above.

### Events and email

- Every checkout, payment and refund webhook event carries `payment_link_id` and `payer_note`
  (`null` when absent), built in `checkout/session-refs.ts` and applied in `checkout/webhooks.ts`.
  Link sessions have no `external_ref`.
- The payment notice email (`jobs/payment-notices.ts`) names the link by its title and quotes the
  payer note as plain text (every line behind `> `), never as markup or a clickable link.

### Deploy settings

| Variable | Where | Meaning |
| --- | --- | --- |
| `WEB_INTERNAL_TOKEN` | API and web | Shared secret, at least 32 characters. Required in production in both apps: each refuses to start without it (the web server checks at boot, `src/instrumentation.ts`). Must be identical in both apps. Without it every payer shares the web server's rate limit bucket. |
| `TENDR_ASSET_ORIGIN` | web | Origin Tendr hosts merchant logos from. Preview cards load logos only from here; unset means no logo is ever fetched. |
| `CHECKOUT_BASE_URL` | API and web | Canonical base of every link: `https://usetendr.tech` in production. The API builds `url`/`qr_url` with it and the web app builds QR targets and meta tags. They must agree. |

All three are in `turbo.json`. Never store them in Postgres.

### Not built in this project

- No dashboard screens (this note is the brief for them).
- Merchant slugs never change (they are NEAR account labels), so links need no redirect handling.

## 2. Things the dashboard will meet

- Test and live links are separate rows. `url` for a test link already ends in `?mode=test`; use it as
  returned.
- `availability` is the truth about whether a link takes payments right now; `status` is only the
  merchant's on/off switch.
- Money fields are decimal strings. Format them with the link's currency; the public view also carries
  `minor_units`.
- `use_count` counts settled payments only; open sessions reserve a use but do not appear in it.
- The list is newest first, paged with `starting_after`; archived links need `include_archived=true`.

## 3. Suggestions (not a spec)

Ideas the dashboard might use. The product team decides what to build and how it looks.

- A link list that shows each link's status, how much it has taken, and how many times it has been used.
- A create and edit form with a live preview of what the payer will see.
- A link detail page with copy link, a QR code to download, the link's recent payments, and any
  payer notes.
- A way to see the payments that came through links among all payments.
- Clear wording for switched off, archived and used up, since the payer sees them the same way.
- Warning copy where a choice cannot be undone, such as the address of a link being permanent.
