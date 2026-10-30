# Checkout Themes — Design (Project 5c)

Status: draft for the user's review, 2026-10-30. Builds on foundation (1), merchant accounts (2), checkout core (3), WooCommerce plugin (4), gasless payments (5a) and payment links (5b), all merged on local main.

As in every project 5 design, **we do not build dashboard screens**. We build the API, the shopper-facing pages and the infrastructure, document how they work, and only *suggest* screens to the dashboard owner *(user: "We would suggest and not map out. The only thing we map out is how the api's, and infra we have built works")*.

Throughout, *(user)* marks the user's decisions and *(my call)* marks decisions I made that the user can overturn.

## Intent

A merchant wants the checkout **not to feel like leaving their store** *(user)*. The moment a shopper presses Pay is the moment they are most likely to wonder whether this is a scam, and crypto starts with a trust deficit. So the checkout should:

1. **Still feel like the store:** its logo, colours, typeface and tone.
2. **Make clear what's being bought:** product name and image, and the price in the currency the shopper has been seeing all along (naira for a Lagos store).
3. **Feel as easy as paying by card:** calm, familiar, one obvious button, plain words. It should not look like a crypto app.
4. **Match the kind of brand:** fashion is quiet and elegant; gaming is dark, bold and celebratory; a church or nonprofit is warm and thanks the giver in its own words; a SaaS tool is clean and minimal.
5. **Look right on a phone,** since shoppers mostly arrive from Instagram, WhatsApp and X.
6. **Look good after the sale too,** with a success screen the merchant is proud of.

Most merchants will spend two minutes on this, so the defaults must get them about 80% of the way: their brand is pulled in automatically, and they start from a preset. The few who want more get blocks, custom CSS and custom HTML *(user)*. Merchants do **not** want to own the trust machinery (the amount, who is being paid, address warnings, refund promises). Those just work, styled to match *(user)*.

## Goals

1. **Presets as starting points** *(user)*: Fashion, Gaming, Nonprofit, Minimal, or a blank start. Picking a preset copies it into the merchant's own theme, and **every setting stays editable** *(user: "we can have defaults themes but the user should be able to customise it")*.
2. **Brand settings:** logo, brand/accent colour, background, text colour, light / dark / follow-the-phone mode, font, corner shape, button words, thank-you message, and support and terms links.
3. **Blocks the merchant can reorder, hide and add,** from a generous library *(user: include blocks; "allow the merchant be creative")*.
4. **Custom CSS** *(user)* and a **custom HTML block** *(my call, to serve "be creative")*, both checked when saved.
5. **A sealed Tendr payment block** that merchants can move up or down the page but cannot change, cover or remove (approved in mockup review).
6. **Brand pulled in automatically** from two sources *(user: "you can support both or do the best")*:
   - the WooCommerce store, when it connects;
   - any website address the merchant pastes.
7. **Uploads** for logos, images and fonts.
8. **Several themes per merchant, with one default.** A checkout session or payment link can name a different theme *(my call, accepted in playback)*.
9. **Drafts and publishing:** shoppers never see an edit until the merchant publishes *(accepted in playback)*.
10. **A preview link** for any draft, rendering the real checkout with a sample product (accepted in playback).
11. **Order summary data:** a checkout session can carry the product names, images and quantities, and the WooCommerce plugin sends them. Without this, goal 2 of the Intent ("what's being bought") can't be met *(my call)*.
12. Themes apply to the **hosted checkout, the embedded widget, the payment-link page, and their success and expired screens**.

## Non-goals (later projects)

- **Languages / translation** of the checkout. This is the next project after this one (agreed split).
- **Branded emails and receipts.** These need a real email provider first (agreed split).
- **AI theme designer.** Waits for the AI layer in project 6 *(user)*.
- **Lookalike-brand detection** (Risk). It goes with the AI layer.
- **Dashboard theme editor screens.** These are handed over (see §11).
- **Shopify brand pull.** Comes with the Shopify app in project 6.

## Anti-goals (failure even if it technically works)

- **A theme that can fake or hide payment facts.** If any combination of settings, blocks, CSS or HTML can:
  - change, cover, hide, shrink or push off-screen the amount, the payee, the address, the network warning or the refund promise; or
  - put a fake address or a fake "send to" instruction anywhere on the page,
  then the design has failed.
- **Collecting shopper information through a theme.** No forms, inputs or anything that asks the shopper to type something (payment links are "no other payer info" *(user, 5b)*; a custom form on a payment page is the classic phishing tool).
- **A broken theme taking down checkout.** A bad or missing theme must never stop a shopper paying. The checkout falls back to the Tendr default look.
- **A crypto-app look by default.** The presets read like familiar card checkouts.
- **Desktop-first presets** that look wrong on a phone.

## 1. What already exists

- **Database (project 1):** `checkout_themes` and `theme_assets` exist in full (`apps/api/prisma/schema.prisma`, `CheckoutTheme` and `ThemeAsset`). `CheckoutTheme` has:
  - `name`, `isDefault`, `version`, `status` (`draft|published`), `displayName`, `logoUrl`;
  - `accent`, `background`, `text`, `mode` (`light|dark|auto`), `font`, `cornerRadius`, `layout` (`modal|inline|page`);
  - `blocks` (JSON), `schemaVersion`, `customCss`, `cssHash`, `cssValidation`;
  - `buttonLabel`, `successMessage`, `supportUrl`, `termsUrl`, `tokenPreferences`.

  `Session.themeId` and `PaymentLink.themeId` are foreign keys to it. The builder may migrate this shape as needed.
- **What's wired:**
  - Only `displayName` and `logoUrl` reach the shopper, in the session view (`apps/api/src/checkout/quotes.ts`) and the public link view (`apps/api/src/payment-links/public.ts`).
  - No endpoint creates or edits themes.
  - Nothing writes `ThemeAsset`.
- **Checkout styling:** `apps/web/src/app/globals.css` uses Tendr-only CSS variables (`--tendr-*`, `packages/ui/src/tokens.css`). The page is fixed dark navy, with no per-merchant override and no light mode.
- **Order data:** sessions carry no line items, only `metadata`.
- **WooCommerce:** the plugin sends no brand details. Its spec lists "Checkout logo and colours (project 5 themes)" as something it gains later.
- **Uploads:** there is no object storage. `TENDR_ASSET_ORIGIN` exists only for fetching OG-image logos (`apps/web/src/lib/og-logo.ts`).

## 2. Themes

### 2.1 Settings

| Setting | Notes |
|---|---|
| Name | The merchant's label, e.g. "Main store", "Black Friday". Not shown to shoppers. |
| Display name and logo | Shown in the header block. |
| Colours | Accent (buttons, highlights), background, surface (cards), text. The builder adds `surface` if needed. |
| Mode | `light`, `dark`, or `auto` (follows the shopper's phone). With `auto`, the theme holds a light and a dark palette *(my call)*. |
| Font | From a curated list of about 15 web fonts served by Tendr, or an uploaded `.woff2` *(my call)*. |
| Corner shape | Square to fully round, applied consistently. |
| Button words | E.g. "Complete purchase", "Give ₦50,000", "Get my gems". The amount may be included through a placeholder that Tendr fills. Free text can never state an amount. |
| Thank-you message, support and terms links | As today's columns. Links are https only. |
| Celebration effect | None, confetti or a subtle pulse on success. It is off when the shopper has "reduce motion" on. |

**Contrast:** text and button colours must meet WCAG AA contrast against their backgrounds. A save that fails is refused with the failing pair named *(my call)*.

### 2.2 Presets

There are four presets plus blank: **Fashion** (light, serif, square, quiet), **Gaming** (dark, bold, rounded, confetti), **Nonprofit** (warm, soft, pill buttons, a thank-you message), **Minimal** (clean, Stripe-like, `auto` mode). Blank is the Tendr default look.

A preset is a complete set of settings and a block list. Choosing one creates the merchant's own draft. Presets are defined in code and versioned, and they are listed by the API. All four were seen in the mockup review (`.superpowers/brainstorm/…/presets.html`).

### 2.3 Several themes, a default, and which one shows

- A merchant may keep several themes (up to 20 *(my call)*). One published theme is the default.
- **Which theme a shopper sees:**
  1. the theme named on the session (`theme_id` at creation) or on the payment link;
  2. otherwise the merchant's default;
  3. otherwise the Tendr default look.

  A named theme that is not published, or is deleted, falls through to the next rule. The checkout never fails because of a theme.
- Themes are **shared between test and live mode** *(my call)*. To keep test credentials from changing what live shoppers see:
  - Drafts, uploads, previews and validation work in either mode.
  - **Publishing and changing the default need live-mode credentials,** or a dashboard user, who acts on the live store.
  - A test-mode secret key gets 403 on `/publish` and `/default`.
  - A **test-mode session** may name a *draft* theme in `theme_id` and renders that draft. That's how a merchant tries a theme on a real test payment before publishing. Live sessions only ever render published themes.
- A theme in use by a payment link cannot be deleted. The API says which links use it.

### 2.4 Drafts and publishing

- Every edit goes to a **draft**. Shoppers see only the **published** version.
- A published theme keeps showing while its next draft is edited. Publishing replaces the published version in one step and increments `version`. The builder decides the storage, e.g. a draft copy beside the published row.
- Shoppers see a newly published version on their next page load, even mid-session. Amounts, addresses and deadlines never depend on the theme, so this is safe.
- **Publishing and changing the default require step-up confirmation,** as other sensitive settings already do (`withStepUp` in the dashboard). Saving drafts does not *(my call: a theme changes what every shopper sees on a payment page)*.
- Who may edit: store owners and admins, as with checkout settings.

## 3. Blocks

The checkout is an ordered list of blocks. **Merchant blocks** can be reordered, hidden, added and removed. The **sealed payment block** is placed somewhere in the list exactly once and can be moved, but never hidden or removed.

### 3.1 The sealed payment block (Tendr's)

It contains, unchangeable by the merchant:
- the amount (local currency with the crypto equivalent);
- who is being paid;
- the choice of token and network;
- the Pay button;
- deposit address, QR and network warnings;
- timers;
- errors and status;
- the refund promise and the non-custodial hold notice.

**Who is being paid** shows the merchant **account** name (`Merchant.name`), not the theme's display name. Someone who takes over a dashboard account cannot rename the payee by editing a theme *(user)*.

This changes current behaviour: today the payee shown is `theme.displayName ?? merchant.name` (`apps/api/src/checkout/quotes.ts`). The display name moves to the header block only.

The theme styles the block only through its settings (colours, mode, font, corner shape, button words). Merchant CSS and HTML cannot reach it (§4).

### 3.2 Block library

The list below is *(my call, the user asked for a creative set)*:

| Group | Blocks |
|---|---|
| Content | Rich text, heading, image, banner (image or colour with overlay text), video (YouTube / Vimeo, privacy-enhanced embeds), divider, spacer |
| Layout | Columns (two side by side, each holding blocks); section (groups blocks on a colour or image background) |
| Order | Order summary: product images, names, quantities and line amounts from the session (§6), or the link's title and description on a payment link. Hidden automatically when there is nothing to show. |
| Trust and selling | Trust badges (from a Tendr set plus the merchant's images), reviews / testimonials, FAQ (expand/collapse), countdown to a merchant-set time, delivery or returns note |
| Brand | Header (logo, name), social links, footer links |
| Free-form | Custom HTML (§4.2) |

- The **countdown** must be visually distinct from the payment block's session timer and cannot be labelled as a payment deadline. Its label is free text but cannot contain the words used by the sealed block's timer *(my call; the builder picks the exact rule)*.
- The **success screen** is its own canvas, with its own block list: the thank-you message, image, text, a "Back to store" button (the session's success URL), social links, custom HTML, and the celebration effect. The **expired / cancelled screens** keep Tendr's wording and are styled only.
- Blocks are stored as versioned JSON (`schemaVersion`). Unknown or invalid blocks are dropped at render, never crash the page.
- **Limits** *(my call; the builder may tune them)*:
  - 40 blocks per canvas;
  - 2 levels of nesting (columns or section → blocks);
  - 5,000 characters of text per block.

## 4. Custom CSS and custom HTML

This section is the safety core. The rules below are *(my call)* and serve the anti-goals; the builder chooses how to enforce them, but every rule must hold and be tested.

### 4.1 Custom CSS

- **Scope:** merchant CSS styles merchant blocks and the page background only. It cannot select, style, overlay or affect the sealed payment block or its ancestors.
  - **Suggested approach:** render the payment block in its own shadow root (so selectors can't reach in).
  - Prefix every merchant selector with the merchant-blocks scope, and reject selectors that escape it (`:root`, `html`, `body`, `*` at top level, `:host`, and similar).
  - Give each merchant block CSS containment (`contain: paint`, its own stacking context), so nothing drawn inside a block can escape its box to cover the payment block.
- **Rejected:**
  - `@import`;
  - `url()` pointing anywhere except Tendr's asset origin;
  - external `@font-face` sources;
  - `expression`, `behavior` and `-moz-binding`;
  - `position: fixed` and `position: sticky`;
  - anything that can affect elements outside the block's box.
- **The payment block always stays visible and readable** on every screen size. Tendr enforces a minimum size and visibility for it regardless of merchant CSS.
- **Limits:** 50 KB of CSS.
- **Checked on save:** the CSS is parsed (never regex-filtered) and validated. A rejection gives a plain reason with the line, e.g. "`position: fixed` isn't allowed — it could cover the payment details". `cssValidation` stores the result and `cssHash` the hash. Only validated CSS is ever served.

### 4.2 Custom HTML block

- It is sanitised on save with an allowlist.
- **Removed or rejected:**
  - script of any kind, event-handler attributes and `javascript:` URLs;
  - `iframe`, `object`, `embed`, `form`, `input`, `button`, `select`, `textarea`, `link`, `meta`, `base`, `style` and `svg` elements.
- **Images:** from Tendr's asset origin only.
- **Links:** https only. They open in a new tab with `rel="noopener noreferrer"`.
- **Inline `style` attributes** go through the same CSS validator.
- **Limits:** 20 KB per block.
- **Containment:** the block is subject to the same containment as any merchant block.

### 4.3 Shared rules

- **No shopper input anywhere:** no forms, inputs or editable content in any block, CSS or HTML (anti-goal).
- **No fake payment instructions:** text that looks like a crypto address, or "send … to …" phrasing, in merchant-authored text or HTML is rejected on save.
  - Detection is a best-effort pattern check for EVM, NEAR, Solana and Bitcoin address shapes.
  - Rejections give a plain reason.
  - This is *(my call)*; the builder sets the patterns.
- **The same address check covers text from outside the theme.** `line_items` names and descriptions and payment-link titles and descriptions also render near the payment block *(my call)*:
  - Session creation is **never rejected** for this, so a real store's checkout can't break over a product name.
  - At render, any address-like run in those fields is **masked** (shown as `•••`).
  - Payment-link create and update reject such text going forward, with a plain reason. Existing links are masked at render.
- **Images are an accepted risk** *(my call)*: any image, including a product image from the store's host, could show a fake QR code. The sealed payment block shows the real address and QR and states that funds go only to the address shown inside it. The Mintlify guide and the handover note record this.
- **The checkout page's Content-Security-Policy** keeps blocking scripts and third-party sources other than Tendr's asset origin and the two video embed hosts.

## 5. Uploads and assets

- **Storage:** S3-compatible object storage *(my call)*.
  - The provider is set by env vars, with Cloudflare R2 as the intended default.
  - Locally and in tests it runs as MinIO in Docker. Nothing is installed on the host, and nothing is deployed until the user says so.
- **Asset origin:** assets are served from a dedicated asset origin (`TENDR_ASSET_ORIGIN`, e.g. `https://assets.usetendr.tech`), separate from the checkout's origin.
  - It serves strict headers: `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff`, and a correct `Content-Type`.
  - The existing OG-logo fetch (5b) already trusts exactly this origin.
- **Upload path:** through the API (`multipart`), so the server checks every file before storing *(my call; files are small)*. Each upload creates a `ThemeAsset` with a checksum.
- **Accepted files** *(my call)*:

  | Kind | Formats | Size cap |
  |---|---|---|
  | Logos and images | PNG, JPEG, WebP, GIF | 2 MB |
  | Logos and images | SVG, sanitised (no script, no external references) | 512 KB |
  | Fonts | `.woff2` | 500 KB |

  The type is sniffed from the bytes, not trusted from the name.
- **Limits:** 200 assets per merchant *(my call)*.
- **Assets are immutable:** a new upload gets a new URL. An asset referenced by any published theme cannot be deleted.

## 6. What's being bought (order summary data)

- **Session creation** gains optional `line_items`: up to 50 items, each with:
  - `name`;
  - `quantity`;
  - `unit_amount` (in the session's `amount_currency`);
  - an optional `image_url` (https), and an optional `description`.

  The items are display only. The session `amount` stays the amount charged. A mismatch between the items and `amount` is allowed (discounts, shipping and tax may be applied); the summary can show a "Shipping / tax / discount" difference line *(my call)*.
- **Product images** are the one place an image may come from outside Tendr, because they come from the merchant's own store.
  - They render as plain images with `referrerpolicy="no-referrer"`, inside the order-summary block, under the CSP's image allowance for https.
  - If an image fails to load, it is hidden.
  - This is *(my call)*. The alternative, proxying every product image through Tendr, is left to the builder if CSP needs it.
- **The WooCommerce plugin** sends the cart's items (name, quantity, line price, featured image URL) when it creates a session.
- **Payment links** show the link's title and description (5b) in the order-summary block.

## 7. Brand pulled in automatically

Both routes produce a **draft** theme, based on the closest preset, for the merchant to review. Neither ever publishes anything.

- **From WooCommerce** *(user)*:
  - When the store connects, the plugin sends the site name, site icon / custom logo URL and colour palette. The palette comes from the block theme's `theme.json`, or the classic customizer's colours where available.
  - The plugin settings get a "Refresh brand from my store" action that sends them again.
  - Tendr copies the logo into its own storage (an asset), rather than hot-linking it.
- **From any website** *(user)*:
  - The merchant pastes an address. Tendr fetches the page and reads its logo candidates (`apple-touch-icon`, `og:image`, the site icon, and the favicon as a last resort), its `theme-color`, and its name.
  - If no colour is declared, Tendr takes the dominant colour of the chosen logo.
- **Fetch safety (as 5b's OG fetch):**
  - public https only;
  - the resolved IP must be public (no private, loopback, link-local or metadata ranges), checked on every redirect hop;
  - a small number of redirects;
  - 5 s timeout;
  - a 2 MB response cap per resource.
  - Rate limits: 10 brand pulls per merchant per hour *(my call)*.
- The result always passes the same contrast and asset checks as a manual edit. If nothing usable is found, the merchant gets the preset with their name filled in.

## 8. Rendering

- **The shopper's view** of a session and of a public link includes the resolved, published theme: settings, blocks, validated CSS and asset URLs. Only the fields needed to render are sent.
- **Fallback:** if anything about the theme fails to load or validate at render time, the page renders with the Tendr default look. Payment never depends on the theme.
- **The `--tendr-*` CSS variables** become the theme's variables, so every existing component picks up colours, font and corner shape. The default values remain today's Tendr look.
- **Light / dark / auto modes** are supported across the checkout and link pages. Today's navy dark look becomes the Tendr default theme's dark palette.
- **Phone-first:**
  - every preset and block is designed and tested at 375 px wide first;
  - the payment block must be fully visible without horizontal scrolling at that width.
- **Motion:** celebration effects and any block animation respect `prefers-reduced-motion`.
- **Embedded widget:** the store's own code keeps choosing modal or inline (`Tendr.open` / `Tendr.mount` in `apps/web/src/embed/tendr.ts`). The theme only styles the content inside the frame. The theme's `layout` column is unused and may be dropped *(my call)*.
- **Payment options:** the theme's `tokenPreferences` column is dropped. Which tokens and networks are offered stays in checkout settings, so a theme can never change what a shopper can pay with *(my call)*.
- **Preview cards (5b's OG and Twitter images):** use the theme's logo, accent and background.

## 9. Preview

- `POST /v1/themes/:id/preview` returns a short-lived preview URL (15 minutes *(my call)*). It renders the draft as a real checkout page with a sample product in the merchant's default currency.
- The URL has options for the sample (store checkout or payment link), mode (light or dark) and screen (phone or desktop), so the dashboard can show it in a phone frame.
- Preview pages are clearly marked "Preview", take no payments, and are `noindex`.
- They need no login, but their token is unguessable and expires. They cannot be used to render arbitrary content: they render only that merchant's draft, which has already passed every save check.

## 10. Merchant API

All endpoints are under `/v1`, follow the existing conventions (scoped clients, idempotency keys on create, strict schemas, cursor lists), and get SDK methods (`client.themes.*`, `client.themeAssets.*`).

| Method | Path | Does |
|---|---|---|
| GET | `/themes/presets` | Lists the presets (settings and blocks). |
| GET / POST | `/themes` | Lists themes, or creates a draft (blank, from a preset, or a copy of another theme). |
| GET / PATCH / DELETE | `/themes/:id` | Reads (published and draft), edits the draft, or deletes the theme. Deleting is refused while the theme is default or used by a link. |
| POST | `/themes/:id/publish` | Publishes the draft (step-up). |
| POST | `/themes/:id/default` | Makes the theme the default (step-up; must be published). |
| POST | `/themes/:id/preview` | Returns a preview URL. |
| POST | `/themes/validate` | Checks settings, blocks, CSS and HTML without saving, and returns the same errors a save would. |
| POST | `/themes/from-website` | `{ url }` → a new draft from the website brand. |
| POST | `/themes/from-store` | `{ connection_id }` → a new draft from the connected WooCommerce store's last-sent brand. |
| POST / GET / DELETE | `/theme-assets` | Uploads, lists and deletes assets. |

Session and link endpoints also change:
- Session creation gains `theme_id` and `line_items`.
- Payment-link create and update gain `theme_id`.
- The connect-token exchange (or a new plugin endpoint) accepts the store's brand details.

Webhooks: none new *(my call)*.

## 11. Documentation and handover

- **Mintlify:**
  - a "Branding your checkout" guide (presets, brand pull, blocks, CSS and HTML rules with every rejection reason);
  - an API reference for every endpoint above;
  - the session `line_items` and `theme_id` fields.
- **Handover note** `docs/handover/2026-10-30-checkout-themes.md`. It **maps out the API, the infrastructure and the safety rules** and only **suggests** editor screens:
  - preset picker;
  - brand-pull prompt;
  - settings panel;
  - block list with drag-and-drop;
  - CSS and HTML editors with inline errors;
  - phone-frame preview;
  - publish with step-up.
- **README:** new env vars:
  - object storage credentials and bucket;
  - `TENDR_ASSET_ORIGIN`, now also used for uploads;
  - any font-serving settings.
- **The WooCommerce plugin** gets a version bump and a changelog entry for brand sending and line items.

## 12. What's left to the builder

- **Storage and fit:** the exact storage shape for drafts versus published versions, and how `blocks` JSON is versioned and migrated.
- **Libraries:** the CSS parser and HTML sanitiser (well-maintained, server-side), and the dominant-colour method.
- **Content:**
  - the curated font list;
  - the trust-badge set;
  - the exact visual design of the four presets, true to the approved mockups;
  - each block's exact JSON shape.
- **Detection:** the exact address-pattern and countdown-label rules (§3.2, §4.3).
- **Limits:** all numeric limits marked *(my call)* may be tuned with a note in the handover.
- **Safety isolation:** how the payment block is isolated (shadow root or equivalent). The **anti-goals are the test**: the builder must include tests that try to cover, hide, shrink, restyle, push off-screen and impersonate the payment block, and to collect input, through each of settings, blocks, CSS and HTML.
