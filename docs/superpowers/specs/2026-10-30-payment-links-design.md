# Payment Links — Design (Project 5b)

Status: approved by the user 2026-10-30. Builds on foundation (1), merchant accounts (2), checkout core (3), WooCommerce plugin (4) and gasless payments (5a), all merged on local main.

Project 5 is three designs, in this order (user's decision): 5a gasless payments + relayer + hooks (done), **5b payment links** (this document), 5c checkout branding. As in every project 5 design, **we do not build dashboard screens**. We build the API, the payer-facing pages and the infrastructure, document how they work, and only *suggest* screens to the person who owns the dashboard (user's decision: "We would suggest and not map out. The only thing we map out is how the api's, and infra we have built works").

Throughout, *(user)* marks the user's decisions and *(my call)* marks decisions I made that the user can overturn.

## Intent

A merchant creates a link once and shares it anywhere — WhatsApp, Instagram, a printed QR code on a church notice board or a market stall — and anyone who opens it can pay them in crypto. The people this is for *(user)*:

- **Small online sellers** sharing a link for an item on WhatsApp and Instagram.
- **A church** receiving tithes and offerings.
- **An NGO** collecting donations.
- "And lots more": anyone who wants to be paid without running a store.

A payment link is only for making a payment, fixed or at the payer's discretion. It does not collect shipping details, names or anything else about the payer *(user)*: "the use of payment link is to make payment whether fixed or users descretion. so we don't need all these other info".

## Goals

1. **Two kinds of link** *(user)*:
   - **Fixed price:** the merchant sets the amount (a seller's item).
   - **Payer chooses the amount:** the payer types how much (a tithe, an offering, a donation).
2. **An optional note box** on both kinds, so a payer can write "tithe", "for Mama Ngozi's hospital bill" or an order detail. It is never required *(user)*.
3. **Reusable:** one link can be paid many times by many people. The merchant can switch it off or give it an expiry date *(user, accepted in playback)*.
4. **Currency:** the price, or the payer's chosen amount, is in USD or a local currency such as naira, converted to USD at payment time exactly as API sessions and the WooCommerce plugin are today *(user, accepted in playback)*. The page shows the local amount with the USD equivalent ("₦25,000 ≈ $15.20"), as in the approved mockup.
5. **A minimum on "any amount" links,** so the payment can cover network and swap costs *(user, accepted in playback)*.
6. **Address and QR:** links live at `usetendr.tech/pay/<merchant>/<link>`, as the foundation design set, and every link has a QR code a merchant can download and print *(user, accepted in playback)*.
7. **A preview card** when the link is shared in a chat app: merchant name, link title, and the price or "Pay any amount" (approved mockup).
8. **Getting paid:** the merchant hears about each payment through the same "You got paid" email and the same webhooks as any other payment, and the payer's note is included *(user, accepted in playback)*.
9. **Test mode** works for links like everything else *(user, accepted in playback)*.
10. **Gasless** payments from 5a apply to link payments unchanged.
11. **Handover:** API reference and a Mintlify guide for payment links, plus *suggested* dashboard screens.

## Non-goals

- **Dashboard screens** for creating, editing and listing links (handed over).
- **Links for integrator merchants** whose payments settle into their own contract. Link sessions carry no hook data, so the contract would receive money without its `onTendrDeposit` call. Creating a link is refused for those merchants with a clear error *(my call)*.
- **Collecting payer details:** name, email, phone, shipping address. Payers get the on-screen receipt only; there is no payer receipt email, because we don't ask for an email address *(my call, following the user's "we don't need all these other info")*.
- **Line items, quantities, product images and a cart.** A link has a title and an optional description. Rich order summaries arrive with 5c's order-summary work, and links can adopt them then.
- **Suggested amounts** (preset buttons like ₦1,000 / ₦5,000) on "any amount" links. Easy to add later; not asked for.
- **Embedding a link's checkout on the merchant's own site** using a publishable key. The foundation reserved publishable keys for this; it stays reserved but unbuilt *(my call)*.
- **Branding** of the link page beyond the merchant's name and logo (5c).
- **Recurring payments or subscriptions.**

## Anti-goals (failure even if it technically works)

- **A payer pays a different amount, or pays someone other than the merchant they think they're paying.** The page always shows the merchant's display name and the exact amount before the checkout starts, and the amount is fixed into the session the moment they press "Pay".
- **A switched-off or expired link still takes money.** Every session creation re-checks the link's status, expiry and use limit at that instant.
- **A printed QR code silently stops working** because the link's address changed. A link's slug never changes after it is created *(my call)*.
- **A test-mode link takes real money**, or a live link runs in test mode.
- **The payer's note becomes a way to attack the merchant:** HTML or script in an email or dashboard, a phishing link that looks like it came from Tendr, or unlimited spam into the merchant's inbox.
- **Opening a link creates a payment session.** Bots, chat-app link previews and casual visitors open links constantly. Sessions are created only when the payer presses "Pay".

## 1. What already exists

- **Database:** the foundation created a `payment_links` table (`apps/api/prisma/schema.prisma:925`) with status `active | inactive | expired`, a `slug` unique per merchant and mode, `amount` + `amount_currency`, `open_amount`, `gas_sponsor` + `gas_max_usd`, `max_uses`, `use_count`, `expires_at` and an optional `theme_id`. Sessions already have `payment_link_id` with a composite foreign key that stops cross-merchant and cross-mode links.
- **Merchant handle:** `merchants.slug` is unique and is the `<merchant>` part of the address (foundation design, line 96).
- **Sessions:** `createSession` (`apps/api/src/checkout/sessions.ts:235`) already converts local currencies to USD with live FX and stores the original amount and rate, and already reads a link's gas settings. Nothing enforces a link's status, expiry or use limit yet.
- **Scopes:** `payment_links:read` and `payment_links:write` exist in `packages/contracts/src/auth.ts`.
- **QR:** `apps/web/src/lib/qr.ts` renders QR codes locally.
- **Payer checkout:** `/pay/[sessionId]` loads a session with its client secret from the URL fragment. Link payments reuse it unchanged after the session is created.

## 2. The link

### 2.1 Fields

The table is extended as follows. Field names are the API's; the builder picks column names to match the existing schema style.

| Field | Meaning |
|---|---|
| `title` | Required, shown on the page and preview card. ≤ 80 characters. |
| `description` | Optional, plain text, ≤ 500 characters. **New column.** |
| `slug` | The `<link>` part of the address. Unique per merchant and mode. Lowercase letters, digits and hyphens, 3–60 characters. Generated from the title if not given (with a short suffix when needed to stay unique). **Cannot be changed after creation** *(my call — protects printed QR codes)*. |
| `amount_type` | `fixed` or `open` (maps to the existing `open_amount`). |
| `amount` | Required for `fixed`, absent for `open`. |
| `currency` | `USD` or any ISO 4217 code the FX module supports (`apps/api/src/checkout/fx.ts`, the same list as WooCommerce). Settlement-asset amounts are not offered on links *(my call — payers think in money, not tokens)*. |
| `min_amount` | `open` links only. Optional, in the link's currency. See §2.4. **New column.** |
| `note` | `off` or `optional`. Default `optional` *(my call — the user wants the box available; a merchant selling a fixed item may want it off)*. **New column.** |
| `status` | `active` or `inactive`, set by the merchant. `expired` is reported when `expires_at` has passed (computed when read; the builder may also persist it). |
| `expires_at` | Optional. |
| `max_uses` | Optional. Already in the table. Counts **successful payments**, not page views or sessions. When reached, the link stops taking payments (§2.5); the API reports this as `availability: used_up` alongside `status`. |
| `fee_payer`, `gas_payer` / gas limits | Optional per-link overrides of the merchant defaults, following checkout core's "session → link → merchant" order. The table already has gas sponsorship; **fee payer is new** (`sessions.ts:300` notes it is missing). |
| `theme_id` | Already in the table; unused until 5c. |

**Destination asset and chain** are removed from the link *(my call)*. Link payments settle wherever the merchant's settlement configuration says, like every other session. The existing required `dest_asset`/`dest_chain` columns are dropped (nothing uses them).

### 2.2 Who pays the fees

The merchant decides, per link, as they already can for other payments *(user)*:

- **Merchant pays:** the payer sends exactly the link's amount; Tendr's fee comes out of what the merchant receives.
- **Payer pays:** the fee is taken from the token the payer chooses to pay with, added on top of the link's amount *(user)*, exactly as checkout does today. The link page shows the amount with "plus fees, shown before you pay", and the checkout shows the fee before they confirm. The preview card shows only the link's amount.

The network fee follows the gasless rules from 5a in the same way (merchant sponsors within their gas policy, otherwise it comes out of the payer's token). The link's amount, the $1.00 floor and `min_amount` all apply to the amount the merchant is charging, before fees *(my call)*.

### 2.3 Editing

A merchant can change everything except `slug` and the mode. Changes apply to payments started afterwards; sessions already created keep the amount they were created with. Links are never hard-deleted once a session points at them (the foreign key restricts it). "Delete" in the API **archives** the link: a separate `archived_at` flag, not a new status value. An archived link takes no payments, is hidden from default list results (shown with `include_archived=true`), and can be restored with `PATCH {"archived": false}`. Its public page shows "This link isn't taking payments right now", the same as a switched-off link, so an old printed QR code never looks like a broken page *(my call)*.

### 2.4 The minimum on "any amount" links

- A platform floor of **$1.00 equivalent** applies to every open-amount payment *(my call)*. This sits above checkout's existing $0.50 quote minimum (`MIN_QUOTE_USD`) so a payer who types the floor still gets a quote after fees and price movement. The builder confirms $1.00 is enough against real 1Click minimums and raises it if not.
- A merchant may set a higher `min_amount` in the link's currency.
- The payer page shows the minimum under the amount box ("Minimum ₦1,600") and refuses lower amounts before creating a session. The API enforces it again.
- No maximum *(my call — not asked for; screening applies as with all payments)*.
- **Fixed-price links meet the same floor (review fix).** A fixed amount must be worth at least $1.00 when the link is created or its amount is edited. If the FX rate can't be fetched then, creation is refused with `FX_RATE_UNAVAILABLE`. The check runs again when the payer presses Pay, because rates move. Below the floor, Pay returns `AMOUNT_TOO_LOW` and the page says the amount is too small to pay in crypto right now, instead of failing at the quote.

### 2.5 When a link stops taking payments

A link takes a new payment only when all of these hold at the moment the payer presses "Pay": status `active`, not archived, `expires_at` not passed, successful payments below `max_uses` (if set), and **the merchant can take payments in that mode** (an active account and a settlement configuration — the same readiness check `createSession` already makes). Otherwise the page explains why ("This link isn't taking payments right now" / "This link has expired") and shows no pay button.

Merchants may create links before they finish setting up *(my call — they'll often prepare links first)*. Until they're ready, the link's page shows "isn't taking payments yet", and the API reports `availability: merchant_not_ready` so the dashboard can prompt them.

**These checks apply to every session that names a link,** including sessions created through the store API (`POST /v1/checkout/sessions` with `payment_link_id`). That path keeps working for merchants who build their own page around a link, but it can't take payments a switched-off, expired or used-up link wouldn't *(my call)*. The amount is the caller's on that path, since it's the merchant's own key.

`use_count` goes up when a payment from the link **succeeds**, inside the same transaction that records the success. A later refund does not lower it *(my call — the merchant can raise `max_uses` if they restock)*.

**Reserving a use (review fix).** When `max_uses` is set, each new session reserves one use. Session creation locks the link row (`SELECT … FOR UPDATE`) and counts settled uses plus the link's open sessions: pending sessions not yet expired, plus processing or screening sessions whatever their expiry (a deposit that arrived just before the expiry is still a payment in progress). If that total has already reached `max_uses`, it refuses the new session. This is what makes single-use invoices safe: two payers pressing Pay at the same instant can't both get a session. If every use is settled, the link is `used_up`. If some are only reserved, the payer sees "Someone is paying this link right now, try again shortly." (`LINK_RESERVED`, 409). A pending session's reservation is freed when it expires; a processing or screening session holds its use until it settles or fails. One rare case is left: a session that has passed its expiry but that the expiry sweep hasn't reached yet no longer reserves a use, but a deposit to it still settles. So `use_count` can exceed `max_uses` in that narrow window. A deposit made after the session is marked expired is a late deposit, which checkout refunds, so it never counts as a use. The docs say so.

## 3. Addresses, test mode and the QR code

- **Live links:** `usetendr.tech/pay/<merchant-slug>/<link-slug>`.
- **Test links:** `usetendr.tech/pay/<merchant-slug>/<link-slug>?mode=test` *(my call)*. Slugs are unique per mode, so a test link and a live link can share a slug; the `mode=test` marker picks the test one. Without it, only live links resolve. The test page shows a clear "Test mode — no real money moves" banner, as the checkout already does.
- **Routing:** the web app already has `/pay/[sessionId]`. Next.js does not allow two different dynamic names at the same level, so the builder restructures the `pay` routes (for example a shared first segment that is either a session id or a merchant slug, told apart by the `ses_` prefix). Session URLs must keep working exactly as today. Session ids are matched first. Merchant slugs can't take the session-id shape: signup slugs are `[a-z0-9-]` only, and `isReservedLabel` also refuses any label starting with `ses_`. A test pins both (review fix).
- **Merchant slugs never change.** They are set at signup and are the merchant's NEAR account labels, so shared links can't break that way.
- **Domain:** `usetendr.tech`, as decided in project 2 (the passkey RP ID) and confirmed in project 4. `usetendr.xyz` appears only in the early diagrams and is not used.
- **QR code:** `usetendr.tech/pay/<merchant>/<link>/qr` returns a PNG (default) or SVG (`?format=svg`) of the link's address, large enough to print, with a quiet zone *(my call)*. Public, cacheable, and only for links that exist. Test links' QR codes encode the `?mode=test` address. The API also returns the address and QR URL on every link.

## 4. The payer's page

Follows the approved mockup (`.superpowers/brainstorm/42933-1793110793/content/payment-link-pages-v2.html`):

1. **Header:** merchant logo and display name (the theme's display name if set, otherwise the merchant name, as checkout does today).
2. **Title** and optional **description** (plain text; line breaks kept; nothing turned into links).
3. **Amount:**
   - Fixed: the price in the link's currency with the live USD equivalent ("₦25,000 ≈ $15.20"). USD links show only USD.
   - Open: an amount box in the link's currency, the minimum underneath, and the USD equivalent updating as they type.
4. **Note** (if the link allows it): "Note to <merchant> (optional)", ≤ 280 characters *(my call)*.
5. **"Pay with crypto"** creates the session (§5) and sends the payer into the existing checkout at `/pay/<session>`, where gasless payment, token choice, quotes and the receipt all work as today.
6. **After paying:** the existing checkout success screen, with a "Back to <link title>" link instead of "Return to store" *(my call)*.
7. **Unavailable states:** not found, switched off, expired, used up — each with a plain sentence and no pay button.

The page is server-rendered so chat apps can read its preview (§4.1), works without the payer connecting anything until they press Pay, and loads fast on a mid-range phone on mobile data.

### 4.1 Preview card

The page publishes Open Graph and Twitter card tags, plus a generated preview image showing the merchant's logo and name, the link title, and the price or "Pay any amount". Test links' cards say "Test". Inactive or expired links still render a card (the merchant name and title) but no price *(my call)*.

**The image renderer never fetches an arbitrary URL (review fix).** Theme `logo_url` is free text today. The preview image draws the logo only when the URL is https and its origin is Tendr's own asset origin (the web env var `TENDR_ASSET_ORIGIN`, which 5c's `theme_assets` uploads will use). It fetches with a 3-second timeout, no redirects, a 1 MB limit and an image content type. In every other case it draws the merchant's initial instead. On the page itself the browser loads the logo, so there is no server-side fetch, and the CSP `img-src` already governs it.

## 5. Creating a session from a link

**Where things run** *(my call)*: the web app (`apps/web`) serves the payer's page, the QR route and the preview image, and reads link data by calling the API server-side. The API (`apps/api`) owns the public endpoints below, including their rate limits; the payer's browser calls the API directly to create the session, as the checkout already does for its own calls.

A new **public** API endpoint, called by the payer's page when they press "Pay" *(my call: no key needed, because the link itself is public; the foundation's publishable-key route stays reserved for embedding — see Non-goals)*:

`POST /v1/payment_links/public/<merchant-slug>/<link-slug>/sessions` (with the test-mode marker for test links), body `{ amount? , note? }`.

It:
1. Resolves the link by merchant slug, link slug and mode. Unknown → 404 with no hint whether the merchant exists.
2. Re-checks §2.5 at that instant.
3. For fixed links, ignores any `amount` sent and uses the link's. For open links, validates the amount's precision for the currency and checks the minimum.
4. Cleans the note (§6) and stores it on the session.
5. Calls the same `createSession` logic as the store API, with: the link's currency and FX conversion; the link's fee and gas overrides; `payment_link_id` set; **no `external_ref`** *(my call — there is no order; payments are told apart by session id)*; success and cancel destinations pointing back to the link page.
6. Returns the hosted checkout URL with the client secret in the fragment, exactly as session creation does today. The page redirects to it.

**Abuse limits (revised after review).** Nobody who only knows a link may be able to take it offline.
- **Payer IP is the key everywhere.** The web server renders the page and reads the link server-side, so its requests all come from one address. It therefore calls the API with an internal credential (`WEB_INTERNAL_TOKEN`, a shared env secret, compared in constant time) and passes the payer's IP in `x-tendr-client-ip`. The API trusts that header only alongside a valid credential. Public reads are limited per payer IP, under a global ceiling, and the web server's own address is exempt from per-IP limits when it presents the credential. Session creation is called from the payer's browser, so it already sees the real IP.
- **Unquoted link sessions die fast.** A link session starts with a 5-minute expiry. The first quote on it extends the expiry to the normal session lifetime (counted from creation), in the same transaction as the quote. A session nobody quotes stops holding anything after 5 minutes.
- **The busy ceiling counts only quoted sessions.** A link refuses new sessions (`LINK_BUSY`) when it has 200 open sessions that have a quote. Unquoted sessions don't count, so filling the ceiling means requesting real quotes, which are rate-limited separately.
- **Per-IP cap per link:** at most 3 new sessions per payer IP per link in any 5 minutes, alongside the 10-a-minute per-IP limit across all links.
- The existing global public limits still apply. A CAPTCHA is not added now; the docs list it as the next step if abuse appears.

Public read of a link (`GET .../public/<merchant-slug>/<link-slug>`) returns only what the page shows: merchant display name and logo, title, description, amount type, amount and currency, minimum, note setting, availability and mode. Never the merchant's id, settlement details, limits or counts.

## 6. The payer's note

- Stored as a dedicated field on the session (not mixed into merchant `metadata`) *(my call — merchants own `metadata`)*.
- ≤ 280 characters, trimmed, control characters removed, plain text only. Stored as typed; **escaped everywhere it is shown** (emails, any HTML). Emails show it as quoted plain text, and links in it are not made clickable *(my call — protects merchants from phishing that appears to come from Tendr)*.
- Included in: the "You got paid" email, `payment.*` and `checkout.session.*` webhook payloads for link sessions, and the session and payment API responses.
- Not shown back to anyone except the merchant.

## 7. Telling the merchant

- **"You got paid" email** (`apps/api/src/jobs/payment-notices.ts`): for link payments, the subject names the link instead of an order ("You got paid ₦25,000 via Sunday offering"), and the body adds the link title and the note. Everything else (FX line, fees, network fee, transaction link, test-mode marking) is unchanged.
- **Webhooks:** no new event types. Link payments fire the same `checkout.session.*` and `payment.*` events. Their payloads gain `payment_link_id` and `payer_note` for every session (null when not from a link). This means adding those keys to the webhook payload allowlist (`apps/api/src/checkout/webhooks.ts`) and documenting them. The WooCommerce plugin must keep working with the extra keys (it ignores unknown keys; the builder confirms).
- **Listing payments by link:** the existing session and payment list APIs gain a `payment_link_id` filter.

## 8. Merchant API

Authenticated like the rest of the merchant API (secret keys with `payment_links:*` scopes, and dashboard users), scoped to merchant and mode:

- `POST /v1/payment_links` — create.
- `GET /v1/payment_links` — list, newest first, paginated like other lists, filterable by status; archived hidden unless asked.
- `GET /v1/payment_links/:id` — one link, including its public URL, QR URL, `availability`, `use_count`, and how much it has collected:
  - `total_paid` and `total_refunded` are in the **link's own currency**. Each session's original local amount (`originalAmount`, or `amount` for USD links) is summed, so an NGN link reports naira.
  - `total_paid_usd` and `total_refunded_usd` use the USD value fixed when each session was created (`session.amount`, which checkout already stores in USD for non-USD orders).

  The dashboard can then show what was kept *(my call — the first thing a church or NGO wants to know; local-currency totals added after review)*.
- `PATCH /v1/payment_links/:id` — edit (§2.3); switch on/off via `status`.
- `DELETE /v1/payment_links/:id` — archive.

Responses follow the existing API's shape and error conventions; creation honours `Idempotency-Key` like other create endpoints. The OpenAPI/contracts in `packages/contracts` gain the link schemas, and the TypeScript SDK gains matching methods.

## 9. Documentation and handover

- **Mintlify (`apps/docs`):** a "Payment links" guide (kinds of link, currencies and minimums, the note, test mode, QR codes, preview cards, how `max_uses` reserves a use per open session and the late-deposit caveat, what the payer sees) and API reference pages for §8 and the new webhook fields.
- **Handover note** (`docs/handover/`): how the link API, public endpoints, QR and preview routes work, plus *suggested* screens only: a link list with totals, a create/edit form with a live preview, a link detail page with QR download and "copy link", and payments filtered by link.

## 10. Open items for the builder

- **Stale-session sweep:** `createSession` expires overdue pending sessions by filtering on `external_ref` (`sessions.ts:313`). With no `external_ref`, as link sessions have, that filter disappears and it would expire every overdue pending session for the merchant. The sweep must be skipped, or keyed differently, for sessions without a ref.

- **Next.js route restructure** under `/pay` without breaking session URLs (§3).
- **The $1.00 floor** against real 1Click minimums (§2.4).
- **Webhook allowlist change** must not break the WooCommerce plugin (§7).
- **Preview image generation** method (Next.js image route or similar) and its caching, including invalidation when a link is edited.

## 11. What's left to the builder

Column names and migrations, exact rate-limit numbers, slug generation details, how `expired` is stored, the page's visual design within the approved mockup and the existing checkout styles, and test structure.
