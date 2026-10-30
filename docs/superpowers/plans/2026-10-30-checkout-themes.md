# Checkout Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants brand the hosted checkout, widget and payment-link pages with themes: presets, brand settings, rearrangeable blocks, custom CSS and HTML. Brand details are pulled from WooCommerce or a website, there is a preview link, and line items with Tendr-served product images are shown. Tendr's sealed payment block stays impossible to fake, hide or push out of sight.

**Architecture:**
- A theme is one versioned JSON document (`ThemeDocument`): settings, a checkout block list containing exactly one `payment` block, a success block list, and optional custom CSS. It is defined in `@tendr/contracts` and stored on `checkout_themes` as `draft` and `published` JSON columns.
- An API `themes` module validates documents on save. Validation covers the zod shape, contrast, text rules, and CSS rewritten into per-block scope with `css-tree`. HTML is sanitised with `sanitize-html`. The module stores assets in S3-compatible storage, pulls brands through a shared SSRF-safe fetch, and resolves the theme into the shopper views.
- The web checkout renders a block canvas around the existing payment UI. The payment UI is the sealed block, styled only through theme variables. Tendr adds a phone pay bar and a success canvas.

**Tech Stack:**
- npm workspaces + Turbo (strict env), Node 22, TypeScript ESM.
- API: Fastify 5, `@fastify/multipart`, Prisma 6 / Postgres 16, BullMQ event handlers, zod.
- Theme processing: `css-tree`, `sanitize-html`, `sharp`, `@aws-sdk/client-s3`.
- Local storage: MinIO (Docker).
- Web: Next.js app router, `@fontsource` packages.
- Testing and docs: Vitest, Playwright, Mintlify. WooCommerce plugin in PHP.

**Spec:** `docs/superpowers/specs/2026-10-30-checkout-themes-design.md` (approved 2026-10-30, commit 4de3956).

## Global Constraints

**Repo rules**
- Never add a `Co-Authored-By` trailer or "Generated with Claude Code" line to commits.
- Never store secrets in Postgres. Nothing is deployed or pushed. Never touch the DB named `tendr`: the dev DB is `tendr_foundation`, the test DB `tendr_foundation_test`, Postgres is on 5433 and Redis on 6380. Install nothing on the host (Docker only).
- New env vars go in `turbo.json` `globalPassThroughEnv`, `.env.example` and `apps/api/src/env.ts` (API) as applicable.
- Every merchant-owned query goes through the scoped client (`req.db` / `scopedDb`). `CheckoutTheme`, `ThemeAsset` and the new `ProductImage` are **shared** models (merchant-level, no livemode).

**Safety (spec §3 and §4)**
- The **sealed payment block** contains the amount, payee line, token/network choice, Pay button, address/QR/warnings, timers, errors/status, refund promise and hold notice. Merchant CSS and HTML can never select, cover, move or restyle it.
- Inside the sealed block:
  - Uploaded fonts never apply.
  - A curated font may style only its headings and the Pay button label.
  - Amounts, addresses, the QR caption, the payee line, warnings, errors and timers use Tendr fonts. Addresses use Tendr monospace.
  - Warning, error, success and timer colours are Tendr's fixed light/dark values, never theme colours.
- **Payee:** "You're paying <Merchant.name>". If `namesMatch(displayName, Merchant.name)` is false, also show "<Merchant.name> · trading as <displayName>".
- **No shopper input in any theme:** no forms, inputs, buttons, selects, textareas or contenteditable.
- **Live sessions** render only published themes. A **test-mode** session may name a draft theme and renders the draft.
- **Fallback:** if a theme is missing, invalid or unparsable at render, the page renders the Tendr default theme. Payment never fails because of a theme.
- **Publish and default:**
  - `POST /v1/themes/:id/publish` and `/default` need a live principal (`p.livemode === true`) or a dashboard user. A test secret key gets 403 `FORBIDDEN`.
  - Dashboard users need step-up (`requireStepUp`) and `settings:manage`.
  - Drafts, uploads, previews and validation work in either mode.

**Limits** (spec values; tune only with a handover note)

| What | Limit |
|---|---|
| Themes per merchant | 20 |
| Assets per merchant | 200 |
| Blocks per canvas | 40 |
| Nesting | 2 levels |
| Text per block | 5,000 chars |
| CSS | 50 KB |
| HTML block | 20 KB |
| Raster image | 2 MB (PNG, JPEG, WebP, GIF) |
| SVG | 512 KB, sanitised |
| Font | 500 KB (`.woff2`) |
| Line items | 50 per session |
| Preview URL lifetime | 15 min |
| Brand pulls | 10 per merchant per hour |
| Brand fetch | 5 s timeout, 2 MB per resource, ≤ 3 redirects |

**Text rules** (all in `packages/contracts/src/theme-text.ts`)
- **Button words:** reject any `\p{Nd}`, any `\p{Sc}`, any ISO 4217 code from `ISO_4217_CODES` as a whole word (case-insensitive), and any `{…}` other than `{amount}`.
- **Address-like text:**
  - EVM `0x[0-9a-fA-F]{40}`;
  - bech32 `\b(bc1|tb1)[02-9ac-hj-np-z]{11,87}\b` (case-insensitive);
  - base58 `\b[1-9A-HJ-NP-Za-km-z]{25,44}\b` containing at least one digit and one letter;
  - NEAR implicit `\b[0-9a-f]{64}\b`;
  - NEAR named `\b[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet|tg)\b`.
- **"Send to" phrasing:** `\b(send|transfer|deposit|pay)\b[^.\n]{0,60}\bto\b[^.\n]{0,20}(address|wallet|account|0x|bc1)`, case-insensitive.
- **Countdown labels** may not contain `expire`, `expires`, `expiring`, `expiry`, `session`, `deadline`, `time left`, `pay within` or `left to pay` (case-insensitive).
- **Contrast** (WCAG relative luminance): text vs background ≥ 4.5, text vs surface ≥ 4.5, accent vs background ≥ 3.0, for every palette in the theme.

**Product images and fetching**
- Product images reach shoppers only from `TENDR_ASSET_ORIGIN` after Tendr fetches, validates, re-encodes and caches them.
- Outbound fetches (brand pull, product images, store logos) go only through `safeFetch` (Task 5).

**Web scheme and fonts**
- The Tendr default theme reproduces today's look in dark mode, plus a new light palette.
- The CSS variable names `--tendr-*` stay. New ones:
  - `--tendr-font-mono`;
  - `--theme-font` (brand font);
  - `--theme-accent`, `--theme-bg`, `--theme-surface`, `--theme-text`, `--theme-radius`.

## Review Focus

1. **A merchant publishes a theme whose CSS or HTML tries to reach the payment block.** Attempts include `body *`, `:root`, `.pay-card`, `.tdr-wrap`, `:host`, a negative margin, `transform`, `position:fixed`, a huge `z-index`, `@import`, an external `url()`, `<form>`, `<input>`, `<script>`, `onerror=`, or an address in text. Each must be refused on save with a plain reason and its path. At render, the payment block's bounding box must stay uncovered and unmoved. *(Task 3 `css rejects escapes`, `html strips forms and scripts`; Task 10 e2e `hostile theme cannot cover or move the payment block`.)*
2. **The live default theme's stored JSON is corrupted, or its draft is half-saved.** The shopper sees the Tendr default look and can still pay. The API logs a warning and never returns a 500. *(Task 4 `resolveShopperTheme falls back on invalid stored json`; Task 9 `renders default theme when theme fails to parse`.)*
3. **A WooCommerce cart has a product named like an address, a 404 image URL, an image on a private IP, or 60 items.**
   - The session is still created with the first 50 items. A 51st item is a 400 `VALIDATION_ERROR` from the API, but the plugin truncates to 50 before sending.
   - The address-like name renders masked.
   - The failed and private images show no image.
   - Nothing fetches from a private address.

   *(Task 6 `line items over 50 rejected`; Task 7 `product image fetch refuses private hosts`; Task 6 `view masks address-like item names`; Task 11 plugin test `truncates to 50 items`.)*
4. **A shopper on a 375 px phone opens a theme with a tall banner and FAQ above the payment block.** The pay bar is visible at the bottom showing the amount and payee. Tapping it scrolls the payment block into view, and the bar hides once the block is on screen. *(Task 10 e2e `pay bar appears when payment block is off screen`.)*
5. **A merchant publishes an edit while a shopper is mid-payment.** The shopper's next poll or refresh shows the new look. The amount, address, timer and status are unchanged, and the payment completes. *(Task 4 `republish mid-session changes only theme fields`.)*

---

### Task 1: Theme contracts (document schema, presets, text rules, fonts)

**Files:**
- Create: `packages/contracts/src/themes.ts`, `packages/contracts/src/themes.test.ts`, `packages/contracts/src/theme-text.ts`, `packages/contracts/src/theme-text.test.ts`, `packages/contracts/src/theme-presets.ts`, `packages/contracts/src/theme-presets.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/payment-links.ts` (+ test)

**Interfaces:**
- Produces (`theme-text.ts`):
  - `ISO_4217_CODES: readonly string[]` (move or re-export the codes that `apps/api/src/checkout/fx.ts` `ISO_4217_MINOR_UNITS` uses; the API then imports from contracts);
  - `findButtonWordsProblem(s: string): string | null` (null = ok, else the plain reason);
  - `containsAddressLike(s: string): boolean`, `maskAddressLike(s: string): string` (each match → `•••`);
  - `containsSendInstruction(s: string): boolean`;
  - `findCountdownLabelProblem(s: string): string | null`;
  - `namesMatch(a: string, b: string): boolean`: lowercase, strip punctuation and whitespace, and strip trailing suffixes `ltd`, `limited`, `llc`, `inc`, `co`, `company`, `plc`, `gmbh`, `sa`, `bv`;
  - `contrastRatio(hexA: string, hexB: string): number`;
  - `findContrastProblems(p: ThemePalette): string[]`.
- Produces (`themes.ts`):
  - `THEME_SCHEMA_VERSION = 1` and limit constants named `THEME_MAX_PER_MERCHANT`, `THEME_ASSET_MAX_PER_MERCHANT`, `THEME_BLOCKS_MAX`, `THEME_BLOCK_TEXT_MAX`, `THEME_CSS_MAX_BYTES`, `THEME_HTML_MAX_BYTES`, `LINE_ITEMS_MAX`, with the Global Constraints values.
  - `HexColorSchema` (`^#[0-9a-fA-F]{6}$`).
  - `ThemePaletteSchema { accent, background, surface, text }`.
  - `ThemeFontSchema`: a discriminated union `{ kind:'curated', id: CuratedFontId } | { kind:'asset', asset_id: string }`.
  - `CURATED_FONTS`: a record `id → { family, category: 'sans'|'serif'|'display'|'mono', fontsource: string }` with these 15 ids: `inter`, `dm-sans`, `manrope`, `plus-jakarta-sans`, `space-grotesk`, `outfit`, `sora`, `instrument-sans`, `bricolage-grotesque`, `playfair-display`, `cormorant-garamond`, `lora`, `fraunces`, `dm-serif-display`, `jetbrains-mono`.
  - `ThemeSettingsSchema`:
    - `display_name` (1–80);
    - `logo_asset_id?`;
    - `mode: 'light'|'dark'|'auto'`;
    - `palettes: { light?: ThemePalette, dark?: ThemePalette }`; `light` is required for mode `light`, `dark` for mode `dark`, both for `auto`;
    - `font: ThemeFont`;
    - `corner: 'square'|'soft'|'round'|'pill'`;
    - `button_label?` (≤ 40, must pass `findButtonWordsProblem`);
    - `success_message?` (≤ 500), `support_url?` and `terms_url?` (https ≤ 2048);
    - `celebration: 'none'|'confetti'|'pulse'`;
    - `language?` (BCP-47 `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`);
    - `background_image_asset_id?`.
  - `ThemeBlockSchema`: a discriminated union on `type`. Every block has `id` (`^[a-z0-9-]{1,32}$`, unique within the document) and `hidden?: boolean`. The types and their props:

    | Type | Props |
    |---|---|
    | `header` | `show_logo`, `show_name` |
    | `heading` | `text`, `level: 2\|3` |
    | `rich_text` | `markdown`: a subset of bold, italic, links (https), paragraphs and lists |
    | `image` | `asset_id`, `alt`, `link_url?` |
    | `banner` | `text?`, `asset_id?`, `background?: Hex` |
    | `video` | `provider: 'youtube'\|'vimeo'`, `video_id` (`^[A-Za-z0-9_-]{1,32}$`) |
    | `divider` | — |
    | `spacer` | `size: 'sm'\|'md'\|'lg'` |
    | `columns` | `columns: [ThemeBlock[], ThemeBlock[]]` |
    | `section` | `background?: Hex`, `background_asset_id?`, `blocks: ThemeBlock[]` |
    | `order_summary` | — |
    | `trust_badges` | `badges: Array<{ kind:'tendr', id: 'non-custodial'\|'refund-promise'\|'secure-checkout'\|'verified-merchant' } \| { kind:'asset', asset_id, alt }>` |
    | `reviews` | `items: Array<{ quote, author, rating?: 1..5 }>` (≤ 10) |
    | `faq` | `items: Array<{ q, a }>` (≤ 20) |
    | `countdown` | `label`, `ends_at` (ISO) |
    | `delivery_note` | `text` |
    | `social_links` | `links: Array<{ network: 'instagram'\|'x'\|'tiktok'\|'facebook'\|'whatsapp'\|'youtube'\|'website', url }>` |
    | `footer_links` | `links: Array<{ label, url }>` |
    | `custom_html` | `html` |
    | `payment` | — |
    | `thank_you` | — (renders `settings.success_message`) |
    | `back_to_store` | `label?` |

    Nested blocks may not be `columns`, `section`, `payment`, `thank_you` or `back_to_store`.
  - `ThemeDocumentSchema { schema_version: 1, settings, blocks: ThemeBlock[], success_blocks: ThemeBlock[], custom_css?: string }`, with refinements:
    - exactly one `payment` block, in `blocks` only;
    - `thank_you` and `back_to_store` only in `success_blocks`;
    - the limits;
    - the text rules on every merchant text field (no address-like text and no send instructions in `heading`, `rich_text`, `banner.text`, `reviews`, `faq`, `delivery_note`, `countdown.label`, `success_message`, `display_name`, and link labels; countdown label rule; button words rule).
  - Types `ThemeDocument`, `ThemeBlock`, `ThemeSettings`, `ThemePalette`.
  - API object types:
    - `ThemeObject { id, object:'theme', name, is_default, version, status:'draft'|'published', draft: ThemeDocument, published: ThemeDocument | null, published_at, created_at, updated_at, used_by_links: number }`;
    - `ThemeAssetObject { id, object:'theme_asset', kind:'logo'|'image'|'font', url, mime, size_bytes, checksum, created_at }`.
  - Input schemas:
    - `ThemeCreateSchema` (strict): `{ name, from: { preset: ThemePresetId } | { theme_id } | 'blank' }`;
    - `ThemeUpdateSchema` (strict): `{ name?, draft?: ThemeDocument }`;
    - `ThemeValidateSchema { document: ThemeDocument }`;
    - `ThemeFromWebsiteSchema { url: https, name? }`;
    - `ThemeFromStoreSchema { connection_id, name? }`;
    - `ThemePreviewSchema { sample: 'checkout'|'link', scheme: 'light'|'dark', viewport: 'phone'|'desktop' }`;
    - `LineItemSchema { name (1..200), quantity (int 1..10000), unit_amount (decimal string), image_url? (https ≤ 2048), description? (≤ 500) }`;
    - `ConnectionBrandSchema { site_name? (≤ 120), logo_url?, icon_url? (https), palette: Hex[] (≤ 12) }`.
  - Shopper render shape:
    - `ShopperTheme { id: string | null, version: number, document: ThemeDocument, rendered: Record<string /* block id */, string /* safe html for rich_text blocks */>, assets: Record<string, { url, kind, mime }>, css: string | null /* already scoped */, payee: string, trading_as: string | null }`;
    - `ShopperThemeSchema`, used by web to parse.
- Produces (`theme-presets.ts`):
  - `ThemePresetId = 'blank'|'fashion'|'gaming'|'nonprofit'|'minimal'`;
  - `THEME_PRESETS: Record<ThemePresetId, { label, description, document: (displayName: string) => ThemeDocument }>`;
  - `TENDR_DEFAULT_THEME(displayName: string): ThemeDocument`. This is the blank preset: today's navy dark palette (`--tendr-*` values) plus a light palette. Its blocks are `header`, `order_summary` and `payment`; its success blocks are `thank_you` and `back_to_store`.
  - Preset palettes and fonts follow the approved mockups:

    | Preset | Mode | Palette | Font | Corners | Extra |
    |---|---|---|---|---|---|
    | Fashion | light | `#f7f3ee` / `#1c1a17` | `cormorant-garamond` | square | button label "Complete purchase" |
    | Gaming | dark | `#0d0b1a`, accent `#9b5cff` | `space-grotesk` | round | confetti |
    | Nonprofit | light | `#fffaf2`, accent `#c2410c` (darkened from the mockup's `#e07a3f` to pass 3:1) | `dm-sans` | pill | `thank_you` block, button label "Give {amount}" |
    | Minimal | auto | slate/indigo | `inter` | soft | — |
- Produces (`errors.ts`): append `THEME_INVALID` (400; `details.problems: Array<{ path: string, message: string }>`), `THEME_IN_USE` (409; `details.links: string[]` or `details.reason: 'default'`), `THEME_LIMIT` (409), `ASSET_INVALID` (400), `ASSET_IN_USE` (409), `BRAND_FETCH_FAILED` (422; `details.reason`).
- Modifies (`payment-links.ts`):
  - Link `title` and `description` refine against `containsAddressLike` and `containsSendInstruction`, with the message "Payment link text can't contain wallet addresses or payment instructions".
  - Create and update gain `theme_id?: string | null`.
  - `PublicPaymentLinkView` replaces `merchant: {name, logo_url}` with `theme: ShopperTheme` and keeps `merchant: { name: string /* account name */ }`.

- [ ] **Step 1: Write failing tests**
  - `theme-text.test.ts`:
    - `button words: rejects digits, currency symbols and codes` (`"Pay $1"`, `"Give ₦"`, `"Pay 5"`, `"Pay ٣"`, `"Pay usd now"`, `"Pay {total}"` rejected; `"Give {amount}"`, `"Complete purchase"`, `"Get my gems ⚡"` ok);
    - `detects address-like text` (EVM, bc1, base58 `1BoatSLRHtKNngkdXEeobR76b53LETtpyT`, 64-hex, `kola.near`) with the false-positive guard `"Ships in 2 days from Lagos"` and `"Order #A12345"` false;
    - `maskAddressLike replaces only the address` (`"send 0x…40 now"` → `"send ••• now"`);
    - `detects send instructions` (`"send USDC to this wallet address"` true, `"we send orders to Abuja"` false);
    - `countdown labels cannot imitate the payment timer`;
    - `namesMatch ignores case punctuation and suffixes` (`"Lagos Leather Co."` vs `"lagos leather"` true; `"Kola Kicks"` vs `"Kola Enterprises Ltd"` false);
    - `contrastRatio matches WCAG examples` (`#000000`/`#ffffff` = 21, `#777777`/`#ffffff` ≈ 4.48).
  - `themes.test.ts`:
    - `requires exactly one payment block in blocks`;
    - `rejects payment block nested or in success_blocks`;
    - `rejects duplicate block ids`;
    - `rejects nesting deeper than 2 and over 40 blocks`;
    - `rejects address in banner text, faq answer and display_name`;
    - `rejects input-like props` (unknown keys are refused by strict objects);
    - `requires both palettes for auto mode`;
    - `rejects button_label with amount`.
  - `theme-presets.test.ts`: `every preset parses with ThemeDocumentSchema`, `every preset palette passes findContrastProblems`, `default theme parses`.
  - Extend `payment-links.test.ts`: `link title with an address is rejected`.
- [ ] **Step 2: Run** `npm test -w @tendr/contracts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. Constrain every object with `.strict()`. Markdown is validated, not rendered, here: links must be `https://`, and raw HTML in markdown is rejected.
- [ ] **Step 4: Run** `npm test -w @tendr/contracts && npm run typecheck -w @tendr/contracts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(contracts): theme document, presets and text rules`.

### Task 2: Schema migration and test builders

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`CheckoutTheme` ~1660, `ThemeAsset` ~1699, `Session`, `Connection`, enums ~278-306), `apps/api/src/db/models.ts`, `apps/api/src/test/helpers.ts` (builders ~412-445), `apps/api/prisma/seed.ts`, `apps/api/src/db/schema.test.ts`
- Create: `apps/api/prisma/migrations/20261030120000_checkout_themes/migration.sql`

**Interfaces:**
- Produces (`CheckoutTheme`):
  - Keep `id`, `merchantId`, `name`, `isDefault`, `version`, `status`, timestamps and relations.
  - Add `draft Json`, `published Json?`, `publishedAt DateTime? @map("published_at")`, `publishedCss String? @map("published_css")` (the scoped CSS for the published doc), `draftCss String? @map("draft_css")`, `cssHash String? @map("css_hash")` (hash of `publishedCss`).
  - **Drop** `displayName`, `logoUrl`, `accent`, `background`, `text`, `mode`, `font`, `cornerRadius`, `layout`, `blocks`, `schemaVersion`, `customCss`, `cssValidation`, `buttonLabel`, `successMessage`, `supportUrl`, `termsUrl`, `tokenPreferences`, and the enums `ThemeMode` and `ThemeLayout`.
  - Add a partial unique index: one `is_default = true` row per merchant.
- Produces (`ThemeAsset`): `themeId` becomes optional (assets belong to the merchant and any theme may use them). Add `key String @unique` (object-store key); `url` stays the public URL.
- Produces (`ProductImage`, shared model, `@@map("product_images")`): `id`, `merchantId`, `urlHash String @map("url_hash")` (sha256 hex of the source URL), `sourceUrl String @map("source_url")`, `status ProductImageStatus` (`pending|ok|failed`), `key String?`, `url String?`, `fetchedAt DateTime?`, `createdAt`, with `@@unique([merchantId, urlHash])`.
- Produces (`Session`): `lineItems Json? @map("line_items")`.
- Produces (`Connection`): `brand Json?`, `brandUpdatedAt DateTime? @map("brand_updated_at")`.
- Migration data: no theme rows exist in any environment. Seed rows are rewritten, so the migration may drop columns without backfill. Make it explicit (`DELETE FROM theme_assets; UPDATE … SET theme_id = NULL`, as needed) so `migrate deploy` succeeds on the dev DB.
- Builders:
  - `CheckoutTheme` defaults to `draft = TENDR_DEFAULT_THEME('Test Merchant')`, `published = null`, `status = 'draft'`.
  - `ThemeAsset` no longer creates a theme; it defaults `key = 'assets/<id>'` and `url = 'https://assets.test/assets/<id>'`.
  - Add a `ProductImage` builder.
  - Add `ProductImage` to `SHARED_MODELS`.

- [ ] **Step 1: Failing tests** in `schema.test.ts`:
  - `only one default theme per merchant`;
  - `theme asset may exist without a theme`;
  - `product_images unique per merchant and url hash`;
  - `cross-merchant session theme still rejected` (keep the existing test green).
- [ ] **Step 2: Run** `npm test -w @tendr/api -- schema.test`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, migration, models list, builders and seed. Update `storeInfo` (`apps/api/src/checkout/quotes.ts:~278`) and `public.ts:~108` only enough to compile: select `published` and read `published.settings.display_name`. Task 4 replaces them.
- [ ] **Step 4: Run** `npm run db:migrate:test -w @tendr/api && npx turbo run typecheck test --filter=@tendr/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): theme documents, product images, line items, connection brand`.

### Task 3: Theme validator (CSS scoping, HTML sanitising, document checks)

**Files:**
- Create: `apps/api/src/themes/css.ts`, `css.test.ts`, `html.ts`, `html.test.ts`, `markdown.ts`, `markdown.test.ts`, `validate.ts`, `validate.test.ts`
- Modify: `apps/api/package.json` (add `css-tree`, `sanitize-html`, and their `@types`)

**Interfaces:**
- Consumes: `ThemeDocumentSchema` and the text rules (Task 1).
- Produces:
  - `scopeThemeCss(css: string, assetOrigin: string): { ok: true, css: string, hash: string } | { ok: false, problems: Array<{ line: number, message: string }> }`. Every selector `S` is rewritten to `.tdr-scope S` (inside `@media`/`@supports` too).
    - **Rejected:**
      - at-rules other than `@media`, `@supports` and `@keyframes`;
      - selectors containing `html`, `body`, `:root`, `:host`, `::part`, `::slotted`, `:has(` or any class or id starting with `tdr-` or `pay-`;
      - properties `position` with value `fixed` or `sticky`, `behavior`, `-moz-binding`;
      - any `expression(`;
      - `url()` whose resolved origin isn't `assetOrigin` (`data:` rejected too);
      - a size above 50 KB.
    - Messages are plain, e.g. "`position: fixed` isn't allowed — it could cover the payment details".
    - Parse with `css-tree`; never use regex rewriting.
  - `sanitizeThemeHtml(html: string, assetOrigin: string): { ok: true, html: string } | { ok: false, problems: string[] }` (`sanitize-html`).
    - **Allowed tags:** `p`, `br`, `span`, `div`, `strong`, `em`, `b`, `i`, `u`, `s`, `small`, `h2`, `h3`, `h4`, `ul`, `ol`, `li`, `blockquote`, `a`, `img`, `figure`, `figcaption`, `hr`, `table`, `thead`, `tbody`, `tr`, `th`, `td`.
    - **Allowed attributes:** `class`; `style` (each declaration run through the CSS property rules); `a[href]` (https only); `img[src]` (asset origin only); `img[alt]`.
    - `a` gets `rel="noopener noreferrer" target="_blank"`.
    - Everything else is stripped. A **reject**, not a strip, for `script`, `form`, `input`, `button`, `select`, `textarea`, `iframe`, `object`, `embed`, `svg`, `style`, `link`, `meta`, `base`, `on*` attributes and `javascript:`, so the merchant learns why.
    - After sanitising, the text content must pass `containsAddressLike` / `containsSendInstruction` = false.
    - Over 20 KB → problem.
  - `renderMarkdownSubset(md: string): string`: produces safe HTML for `rich_text` (bold, italic, https links, paragraphs, lists) with everything escaped. It is used by the shopper render (Task 4).
  - `validateThemeDocument(doc: unknown, ctx: { assetOrigin: string, assetIds: Set<string>, assetKinds: Map<string, 'logo'|'image'|'font'> }): { ok: true, document: ThemeDocument, css: { css: string, hash: string } | null } | { ok: false, problems: Array<{ path: string, message: string }> }`. It runs, in order:
    - the zod schema;
    - contrast for each palette;
    - asset references exist and are the right kind (`font.asset_id` → font; images/logo → logo or image);
    - every `custom_html` block through `sanitizeThemeHtml` (replacing `html` with the sanitised output);
    - `custom_css` through `scopeThemeCss`.

- [ ] **Step 1: Failing tests**
  - `css.test.ts`:
    - `scopes simple selectors` (`h2{color:red}` → contains `.tdr-scope h2`);
    - `css rejects escapes` (a table of inputs: `body *{}`, `:root{}`, `.pay-card{}`, `.tdr-wrap{}`, `:host{}`, `h2:has(+ .x){}`, `a{position:fixed}`, `a{position: sticky}`, `@import url(x)`, `@font-face{}`, `a{background:url(https://evil.test/x.png)}`, `a{background:url(data:image/png;base64,AA)}`, `a{behavior:url(x)}` — each `ok:false` with a line number);
    - `allows asset-origin urls and keyframes`;
    - `rejects over 50 KB`;
    - `negative margins are allowed but stay inside the scope` (asserts the output selector is scoped; containment is enforced in web, Task 9).
  - `html.test.ts`:
    - `html strips forms and scripts` (each forbidden element and `onerror=` gives `ok:false` with a named reason);
    - `keeps allowed formatting`;
    - `forces rel and target on links`;
    - `rejects images outside asset origin`;
    - `rejects address text inside html`.
  - `markdown.test.ts`: `escapes html`, `only https links`.
  - `validate.test.ts`:
    - `valid preset passes and returns scoped css`;
    - `unknown asset id is a problem with its path`;
    - `font asset of kind image is rejected`;
    - `low-contrast palette is a problem naming the pair`.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- themes/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): theme validator with scoped css and sanitised html`.

### Task 4: Theme service, merchant routes and shopper theme resolution

**Files:**
- Create: `apps/api/src/themes/themes.ts`, `themes.test.ts`, `resolve.ts`, `resolve.test.ts`, `apps/api/src/routes/themes.ts`, `themes.test.ts`
- Modify: `apps/api/src/app.ts`, `packages/contracts/src/auth.ts` (scopes `themes:read`, `themes:write`; add them to default secret-key scopes), `apps/api/src/checkout/quotes.ts` (`storeInfo`, `shopperSessionView`), `apps/api/src/payment-links/public.ts`, `apps/api/src/payment-links/links.ts` (`theme_id` on create/update)

**Interfaces:**
- Consumes: `validateThemeDocument` (Task 3), the presets (Task 1), and `ThemeAsset` rows (asset upload is Task 5; tests create rows with `createRow`).
- Produces (`themes.ts`, all taking `ThemeCtx = { merchantId, db }`):
  - `listThemes`, `getTheme`;
  - `createTheme(ctx, input: ThemeCreate)`: enforces the 20-theme limit (`THEME_LIMIT`). From a preset it sets the draft to `preset.document(merchant.name)`; `blank` uses `TENDR_DEFAULT_THEME`.
  - `updateThemeDraft(ctx, id, input)`: validates; on failure throws `THEME_INVALID` with problems; stores the normalised draft and `draftCss`.
  - `publishTheme(ctx, id)`: re-validates the draft, copies it to `published` and `draftCss` to `publishedCss`, and sets `status='published'`, `version+1` and `publishedAt`.
  - `setDefaultTheme(ctx, id)`: must be published; done in one transaction that clears the other default.
  - `deleteTheme(ctx, id)`: `THEME_IN_USE` if default or used by any payment link in either mode. Use the unscoped count through a merchant-filtered raw query, since links are per-mode.
  - `validateOnly(ctx, doc)`.
  - `toThemeObject(row, usedByLinks)`.
- Produces (`resolve.ts`): `resolveShopperTheme(db, { merchantId, merchantName, themeId: string | null, livemode: boolean, kind: 'checkout' | 'link', link?: { title, description } }): Promise<ShopperTheme>`.
  - **Order:**
    1. the named theme (published; or its draft when `!livemode`);
    2. the default published theme;
    3. `TENDR_DEFAULT_THEME(merchantName)`.
  - It re-parses the stored JSON with `ThemeDocumentSchema`. On failure it logs a `warn` and moves to the next step.
  - It renders each `rich_text` block's markdown to HTML server-side with `renderMarkdownSubset` into `rendered[blockId]`; the web renders only `rendered`, never raw markdown.
  - It builds an asset map of URLs, sets `payee = merchantName` and `trading_as = namesMatch(displayName, merchantName) ? null : displayName`.
- Changes the session view (`shopperSessionView`):
  - `merchant` becomes `{ name: merchantName }`.
  - Adds `theme: ShopperTheme`.
  - Adds `line_items` (Task 6 fills them).
  - Link titles and descriptions in views pass through `maskAddressLike`.
- Changes the public link view: as in Task 1.
- Routes (`routes/themes.ts`): `themeRoutes: FastifyPluginAsync`, following `routes/payment-links.ts`.
  - **Auth:** principals `dashboard_user` / `secret_key`. Reads use scope `themes:read` and permission `account:read`; writes use `themes:write` and `settings:manage`.

  | Route | Notes |
  |---|---|
  | `GET /v1/themes/presets` | Returns `{ data: Array<{ id, label, description, document }> }`, rendered with the merchant's name. |
  | `GET /v1/themes` | `ListQuerySchema`-style cursor. |
  | `POST /v1/themes` | Create. |
  | `GET /v1/themes/:id` | Read. |
  | `PATCH /v1/themes/:id` | Edit the draft. |
  | `DELETE /v1/themes/:id` | Delete. |
  | `POST /v1/themes/:id/publish` | Live-or-dashboard rule; step-up for dashboard users via `check(req, () => requireStepUp(req))`. |
  | `POST /v1/themes/:id/default` | Same rules as publish. |
  | `POST /v1/themes/validate` | Validation only. |

- [ ] **Step 1: Failing tests**
  - `themes.test.ts` (service):
    - `create from preset uses merchant name`;
    - `21st theme is THEME_LIMIT`;
    - `invalid draft is THEME_INVALID with paths`;
    - `publish copies draft and bumps version`;
    - `editing a published theme leaves published unchanged until publish`;
    - `only one default after setDefault`;
    - `delete refused while default or used by a link`.
  - `resolve.test.ts`:
    - `named published theme wins`;
    - `test session renders named draft, live session ignores draft`;
    - `falls back to default then Tendr default`;
    - `resolveShopperTheme falls back on invalid stored json`;
    - `trading_as set only when names differ`;
    - `rich_text rendered to safe html`.
  - `routes/themes.test.ts`:
    - `test secret key cannot publish or set default (403)`;
    - `live secret key can publish`;
    - `dashboard publish needs step-up (401 STEP_UP_REQUIRED)`;
    - `member without settings:manage gets 403`;
    - `validate returns problems without saving`;
    - `cross-merchant theme id is 404`.
  - Extend `checkout-client` route tests:
    - `session view carries theme, payee and trading_as`;
    - `republish mid-session changes only theme fields` (snapshot the view, publish an edit, and assert that `amount`, `expires_at`, `status` and `quote` are unchanged and `theme.version` increased).
  - Extend the payment-links public test: `public link view masks address-like description from before the rule`.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- themes resolve checkout-client payment-links`. Expected: FAIL.
- [ ] **Step 3: Implement** and register in `app.ts`. Session creation's `theme_id` is Task 6. Link `theme_id` lands here: it must reference a theme of the same merchant (the composite FK handles that), and the service returns 404 for unknown ids.
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --filter=@tendr/api --filter=@tendr/contracts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): theme api and shopper theme resolution`.

### Task 5: Object storage, asset uploads and safe fetch

**Files:**
- Create: `apps/api/src/storage/object-store.ts`, `object-store.test.ts`, `apps/api/src/themes/assets.ts`, `assets.test.ts`, `apps/api/src/themes/sniff.ts`, `sniff.test.ts`, `apps/api/src/lib/safe-fetch.ts`, `safe-fetch.test.ts`, `apps/api/src/routes/theme-assets.ts`, `theme-assets.test.ts`, `infra/docker/minio-init.sh`
- Modify: `apps/api/src/checkout/webhooks.ts` (import the SSRF helpers from `lib/safe-fetch.ts` instead of defining them; behaviour unchanged, webhook tests stay green), `apps/api/src/env.ts`, `.env.example`, `turbo.json`, `infra/docker/docker-compose.yml`, `apps/api/package.json` (`@aws-sdk/client-s3`, `@fastify/multipart`, `sharp`), `apps/api/src/app.ts`

**Interfaces:**
- Produces (`object-store.ts`): `interface ObjectStore { put(key: string, body: Buffer, contentType: string): Promise<void>; delete(key: string): Promise<void> }`, plus `createObjectStore(env): ObjectStore` and `memoryObjectStore(): ObjectStore & { objects: Map<string, { body: Buffer, contentType: string }> }`.
  - The S3 implementation sets `CacheControl: public, max-age=31536000, immutable`.
  - Env: `ASSET_STORE_DRIVER` (`s3` | `memory`; default `memory` in tests, required `s3` in production), `ASSET_S3_ENDPOINT`, `ASSET_S3_REGION` (default `auto`), `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_S3_FORCE_PATH_STYLE` (`true` for MinIO), and `TENDR_ASSET_ORIGIN` (now also read by the API; https in production).
  - `assetUrl(key) = TENDR_ASSET_ORIGIN + '/' + key`.
- Produces (`sniff.ts`): `sniffAsset(buf: Buffer): { mime: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'|'image/svg+xml'|'font/woff2' } | null`, by magic numbers (`wOF2` for woff2). SVG counts only if the decoded text's first non-whitespace token is `<svg` or `<?xml` followed by `<svg`.
- Produces (`assets.ts`):
  - `uploadThemeAsset(ctx, { kind, filename, buf }): Promise<ThemeAssetObject>`.
    - It checks the per-kind type and size (Global Constraints) and `THEME_ASSET_MAX_PER_MERCHANT`.
    - It sanitises SVG with `sanitize-html` in `xmlMode`, using a strict SVG element and attribute allowlist (no `script`, `foreignObject`, `use` with external href, `on*`, `href`/`xlink:href` to non-fragment).
    - For raster images it verifies decodability with `sharp`, rejecting anything over 8000×8000.
    - Key: `assets/<merchantId>/<assetId>.<ext>`; checksum is sha256 hex.
  - `deleteThemeAsset(ctx, id)`: `ASSET_IN_USE` if any theme's `draft` or `published` references the id. Scan the merchant's themes (≤ 20) in code.
  - `listThemeAssets`.
- Routes (`theme-assets.ts`): `POST /v1/theme-assets` (multipart: fields `kind` and `file`, `@fastify/multipart` with `limits.fileSize = 2 MB`), `GET /v1/theme-assets`, `DELETE /v1/theme-assets/:id`. Same auth as themes.
- Produces (`safe-fetch.ts`):
  - `isPrivateAddress`, `assertPublicHost`, `setSafeFetchResolver` (moved from webhooks; webhooks re-export or import).
  - `safeFetch(url: string, opts: { timeoutMs: number, maxBytes: number, maxRedirects: number, accept?: string }): Promise<{ status: number, contentType: string, body: Buffer, finalUrl: string }>`.
    - https only.
    - Every hop's host is resolved and checked, and the IP is pinned at connection time (the webhooks pattern).
    - Redirects are followed manually up to `maxRedirects`, re-checked each hop.
    - It streams with a byte cap.
    - It throws `SafeFetchError` with `reason: 'not_https'|'private_address'|'too_large'|'timeout'|'too_many_redirects'|'bad_status'`.
- `docker-compose.yml`: add `minio` (`minio/minio`, ports 9100:9000 and 9101:9001) and a one-shot `minio-init` (`minio/mc`) that creates bucket `tendr-assets` with anonymous download. `.env.example` gets the MinIO values and `TENDR_ASSET_ORIGIN=http://localhost:9100/tendr-assets`. Production must be https (enforced in `env.ts` when `NODE_ENV=production`).

- [ ] **Step 1: Failing tests**
  - `sniff.test.ts`: `detects each format by bytes not name`; `rejects html disguised as png`.
  - `assets.test.ts` (memory store):
    - `uploads png logo`;
    - `rejects 2.1 MB image`;
    - `rejects woff2 over 500 KB`;
    - `strips script from svg and rejects foreignObject`;
    - `201st asset is rejected`;
    - `asset used by a published theme cannot be deleted`.
  - `safe-fetch.test.ts` (local http server plus the resolver hook):
    - `refuses http`;
    - `refuses private and metadata ips` (`127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `::1`);
    - `rechecks host on each redirect`;
    - `caps body size`;
    - `times out`.
  - `theme-assets.test.ts`: `multipart upload returns asset object with asset-origin url`.
  - Existing `webhooks` tests must still pass.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- storage sniff assets safe-fetch theme-assets webhooks`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Bring the services up with `docker compose -f infra/docker/docker-compose.yml up -d minio minio-init` and verify one manual S3 put against MinIO with a scratch script; don't commit the script.
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --filter=@tendr/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): asset storage, uploads and shared safe fetch`.

### Task 6: Sessions and links: theme_id, line items, masking

**Files:**
- Modify: `apps/api/src/checkout/sessions.ts` (`CreateSessionSchema` ~72, insert ~493, view ~608), `apps/api/src/checkout/quotes.ts`, `apps/api/src/routes/checkout-sessions.test.ts`, `apps/api/src/routes/checkout-client.test.ts`, `apps/web/src/lib/checkout/api.ts` (types only)

**Interfaces:**
- Consumes: `LineItemSchema`, `LINE_ITEMS_MAX` and `maskAddressLike` (Task 1); `resolveShopperTheme` (Task 4).
- Produces:
  - `CreateSessionSchema` gains `theme_id?: string` and `line_items?: LineItem[]` (max 50). `unit_amount` is checked against the session currency's precision with the same rule as `amount`.
  - An unknown or other-merchant `theme_id` → 404 `NOT_FOUND` ("No theme with that id").
  - The merchant API session object returns `theme_id` and `line_items` as sent.
  - Shopper view: `line_items: Array<{ name, quantity, unit_amount, description: string | null, image_url: string | null }>`.
    - `name` and `description` pass through `maskAddressLike`.
    - `image_url` is the cached Tendr URL from `ProductImage` (`status='ok'`), else null. Task 7 fills that table.
  - Web `SessionView` type gains `theme: ShopperTheme` (from contracts), `line_items` and `merchant: { name }`. Web consumers of `view.merchant.logo_url` are updated to compile (logo now comes from the theme). Task 10 does the full rendering.

- [ ] **Step 1: Failing tests**
  - `session create accepts theme_id and line_items`;
  - `line items over 50 rejected`;
  - `line item unit_amount precision follows currency`;
  - `foreign theme_id is 404`;
  - `view masks address-like item names`;
  - `view image_url null until cached, asset url once ok`.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- checkout-sessions checkout-client`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx turbo run typecheck test --filter=@tendr/api --filter=@tendr/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): sessions carry theme and line items`.

### Task 7: Product image caching, brand pull and connection brand

**Files:**
- Create: `apps/api/src/themes/product-images.ts`, `product-images.test.ts`, `apps/api/src/themes/brand.ts`, `brand.test.ts`, `apps/api/src/routes/theme-brand.ts`, `theme-brand.test.ts`
- Modify: `apps/api/src/jobs/register-handlers.ts`, `apps/api/src/gateway/rate-limit.ts` (kind `brand_pull`: 10 per merchant per hour, custom window 60 min), `apps/api/src/app.ts`, `apps/api/package.json` (`htmlparser2` if not already present transitively; declare it)

**Interfaces:**
- Consumes: `safeFetch` and `ObjectStore` (Task 5), presets (Task 1), `createTheme` and `updateThemeDraft` (Task 4).
- Produces (`product-images.ts`):
  - `cacheProductImages(merchantId: string, urls: string[], deps: { store: ObjectStore, fetch?: typeof safeFetch }): Promise<void>`.
    - It upserts a `ProductImage` per URL (`pending`) and skips URLs fetched OK in the last 7 days.
    - Fetch: 5 s, 2 MB, 3 redirects, sniff raster only (no SVG).
    - `sharp` resizes to fit 512×512, re-encodes to WebP q80 and stores at `products/<merchantId>/<urlHash>.webp`.
    - The status becomes `ok` with `url`, or `failed`.
  - `registerProductImageHandler()`: registers an event handler on `session.created` that reads the session's `lineItems` image URLs and calls `cacheProductImages`.
- Produces (`brand.ts`):
  - `extractBrand(html: string, pageUrl: string): { name: string | null, themeColor: string | null, logoCandidates: string[] }` (pure, `htmlparser2`).
    - Candidates in order: `link[rel~=apple-touch-icon]` (largest `sizes` first), `meta[property=og:image]`, `link[rel~=icon]` (largest), then `/favicon.ico`.
    - Name: `og:site_name`, else `<title>` trimmed at the first ` | ` or ` – `.
    - `themeColor`: `meta[name=theme-color]` normalised to `#rrggbb`.
  - `dominantColor(buf: Buffer): Promise<string>`: `sharp(buf).stats().dominant` → hex.
  - `draftFromBrand(merchantName: string, brand: { name, logoAssetId, color }): ThemeDocument`. It uses the `minimal` preset document, sets `display_name = brand.name ?? merchantName` and `logo_asset_id`, and sets the accent to `color`. If the accent fails 3:1 against the background, it darkens or lightens it in 5% steps until it passes. Mode is `light` if the colour's luminance is above 0.4, else `dark`.
  - `themeFromWebsite(ctx, { url, name? }): Promise<ThemeObject>`. It fetches the page (2 MB) and tries logo candidates until one downloads as a raster or SVG and uploads as a `logo` asset through `uploadThemeAsset`. The draft is created through `createTheme` + `updateThemeDraft`. It throws `BRAND_FETCH_FAILED` only when the page itself can't be fetched. A missing logo or colour still produces a draft.
  - `themeFromStore(ctx, { connection_id, name? })`: reads `Connection.brand` (404 if none). Logo: `logo_url ?? icon_url` via `safeFetch`. Colour: the first palette colour that isn't near-white or near-black, else the dominant colour of the logo.
- Routes (`theme-brand.ts`):
  - `POST /v1/themes/from-website` and `POST /v1/themes/from-store`: theme write auth, plus the `brand_pull` limiter keyed by merchant.
  - `PUT /v1/connection/brand`: only a `secret_key` with `connectionId`. The body is `ConnectionBrandSchema`; it stores `Connection.brand` and `brandUpdatedAt`. Any other principal → 403.

- [ ] **Step 1: Failing tests**
  - `product-images.test.ts` (fake fetch plus memory store):
    - `caches resized webp and marks ok`;
    - `product image fetch refuses private hosts` (real `safeFetch` with resolver → `failed`, no store write);
    - `svg product image is failed`;
    - `does not refetch within 7 days`.
  - `brand.test.ts`:
    - `extractBrand picks apple-touch-icon over favicon`;
    - `normalises theme-color`;
    - `draftFromBrand fixes low-contrast accent`;
    - `draft passes validateThemeDocument`.
  - `theme-brand.test.ts`:
    - `from-website creates a draft and never publishes`;
    - `unreachable website is BRAND_FETCH_FAILED`;
    - `11th pull in an hour is 429`;
    - `connection key can PUT brand, dashboard user cannot`;
    - `from-store uses stored brand`.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- product-images brand theme-brand`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --filter=@tendr/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): brand pull and cached product images`.

### Task 8: Preview links

**Files:**
- Create: `apps/api/src/themes/preview.ts`, `preview.test.ts`
- Modify: `apps/api/src/routes/themes.ts` (+ test), `apps/api/src/routes/payment-links-public.ts` or a new `routes/theme-preview-public.ts` (+ test), `apps/api/src/gateway/rate-limit.ts` (reuse `payment_link_read` limits for the public preview read)

**Interfaces:**
- Produces:
  - `createPreviewToken(ctx, themeId, opts: ThemePreview): Promise<{ url: string, expires_at: string }>`. It stores in Redis `theme-preview:<sha256(token)>` → `{ merchantId, themeId, draftVersionHash, opts }` with TTL 900 s. The token is 32 random bytes, base64url. The URL is `${CHECKOUT_BASE_URL}/preview/theme/<token>`.
  - Route `POST /v1/themes/:id/preview` (theme read auth).
  - Public `GET /v1/themes/preview/:token` returns `{ preview: true, opts, theme: ShopperTheme /* draft, resolved as for a test session */, sample: { kind, amount, amount_currency, line_items, link?: { title, description } } }`. Unknown or expired tokens → 404.
    - The sample amount is `25000` NGN if the merchant's last session currency is NGN, else `49.00` USD.
    - The sample line items are 2 fixed items with Tendr-hosted sample images, committed under `apps/web/public/preview/`.
  - The preview read never creates sessions. Responses carry `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

- [ ] **Step 1: Failing tests**
  - `preview token expires after 15 minutes` (fake clock or a TTL assertion);
  - `preview shows the current draft`;
  - `unknown token 404`;
  - `preview read creates no session`.
- [ ] **Step 2: Run** `npm test -w @tendr/api -- preview`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx turbo run typecheck test --filter=@tendr/api`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): theme preview links`.

### Task 9: Web theme runtime (variables, fonts, block renderers)

**Files:**
- Create: `apps/web/src/lib/theme/vars.ts`, `vars.test.ts`, `apps/web/src/lib/theme/parse.ts`, `parse.test.ts`, `apps/web/src/components/theme/BlockCanvas.tsx`, `apps/web/src/components/theme/blocks/*.tsx` (one file per block group: `content.tsx`, `layout.tsx`, `selling.tsx`, `brand.tsx`, `order-summary.tsx`, `custom-html.tsx`), `apps/web/src/components/theme/ThemeStyles.tsx`, `apps/web/src/components/theme/theme.test.tsx`, `apps/web/scripts/copy-fonts.mjs`
- Modify: `packages/ui/src/tokens.css` (add the light-scheme token set under `[data-scheme="light"]` and `--tendr-font-mono`), `apps/web/src/app/globals.css` (block wrapper rules, light-scheme fixes for `.pay-*`), `apps/web/package.json` (`@fontsource/*` or `@fontsource-variable/*` for the 15 curated fonts plus JetBrains Mono, and `prebuild`/`predev` running `copy-fonts.mjs`), `apps/web/.gitignore` (`public/fonts/`)

**Interfaces:**
- Consumes: `ShopperTheme`, `ShopperThemeSchema`, `CURATED_FONTS` and `TENDR_DEFAULT_THEME` (Task 1).
- Produces:
  - `parseShopperTheme(raw: unknown, merchantName: string): ShopperTheme`. It returns the Tendr default on parse failure and logs once with `console.warn`.
  - `themeVars(theme: ShopperTheme, scheme: 'light'|'dark'): Record<string, string>`. It sets `--theme-accent`, `--theme-bg`, `--theme-surface`, `--theme-text`, `--theme-radius` (square 0, soft 8 px, round 16 px, pill 999 px) and `--theme-font`. It also sets `--tendr-indigo`, `--tendr-navy`, `--tendr-surface` and `--tendr-white` from the palette, so existing `.pay-*` rules follow the theme. It **never** sets `--tendr-danger`, `--tendr-warning`, `--tendr-success`, `--tendr-font-sans` or `--tendr-font-mono`.
  - `useScheme(mode): 'light'|'dark'` (`auto` follows `prefers-color-scheme`).
  - `<ThemeStyles theme scheme />`: injects `@font-face` for the brand font. Curated fonts come from `/fonts/<id>.woff2` (copied by `copy-fonts.mjs` from `@fontsource`); asset fonts come from the asset URL. It also injects the scoped `theme.css` inside a `<style>`.
  - `<BlockCanvas blocks theme slots={{ payment: ReactNode, orderSummary?: ReactNode }} />`. Each block is rendered as `<div class="tdr-wrap" data-type><div class="tdr-scope"><div class="tdr-content" data-block={id}>…</div></div></div>`.
    - `.tdr-wrap` gets `contain: layout paint; overflow: clip; isolation: isolate; position: relative` in `globals.css`.
    - Hidden blocks are skipped. Unknown types render nothing.
    - The `payment` slot renders **outside** any `.tdr-scope`: `<section class="tdr-payment" data-sealed>`.
    - `custom_html` (`block.html`) and `rich_text` (`theme.rendered[block.id]`) use `dangerouslySetInnerHTML`, because the server already sanitised them; a `rich_text` block with no rendered entry renders nothing.
    - `video` uses `youtube-nocookie.com/embed/<id>` / `player.vimeo.com/video/<id>?dnt=1` in an `iframe` with `sandbox="allow-scripts allow-same-origin allow-presentation"` and `loading="lazy"`.
    - The countdown ticks client-side and shows "Ended" after `ends_at`.
  - **Sealed-block typography:** in `globals.css`, `.tdr-payment` sets `font-family: var(--tendr-font-sans)` on everything. Only `.tdr-payment :is(h2,h3,.pay-button-label)` uses `var(--theme-font-curated, var(--tendr-font-sans))`, where `--theme-font-curated` is set only when the font kind is `curated`. Addresses (`.pay-address`, `.pay-mono`) use `var(--tendr-font-mono)`.

- [ ] **Step 1: Failing tests**
  - `vars.test.ts`:
    - `never sets state colours or tendr fonts`;
    - `maps corner shapes`;
    - `auto mode needs both palettes`.
  - `parse.test.ts`: `renders default theme when theme fails to parse`.
  - `theme.test.tsx` (testing-library):
    - `renders blocks in order and skips hidden`;
    - `payment slot is outside every tdr-scope`;
    - `asset font never applies inside sealed block` (computed font-family on an amount node in jsdom via the class contract: the amount element has no ancestor carrying `--theme-font`-driven rules; assert through class names);
    - `unknown block type renders nothing`.
- [ ] **Step 2: Run** `npm test -w @tendr/web -- theme`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --filter=@tendr/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): theme runtime and block canvas`.

### Task 10: Web integration (checkout, link page, pay bar, success, preview, CSP) and safety e2e

**Files:**
- Modify: `apps/web/src/app/pay/[id]/components/Checkout.tsx`, `CheckoutHeader.tsx` (split: logo and name move to the `header` block; amount, timer and payee stay in the sealed block), `StatusScreens.tsx` (success canvas, celebration), `apps/web/src/app/pay/[id]/[link]/LinkPay.tsx`, `apps/web/src/app/pay/[id]/[link]/opengraph-image/route.tsx` and `twitter-image/route.tsx` (theme logo, accent and background), `apps/web/src/lib/link-preview.ts`, `apps/web/src/lib/link-card.tsx`, `apps/web/src/lib/csp.ts`
- Create: `apps/web/src/components/theme/PayBar.tsx`, `Celebration.tsx`, `apps/web/src/app/preview/theme/[token]/page.tsx` (+ client component), `apps/web/e2e/themes.spec.ts`, plus fixtures for a hostile theme

**Interfaces:**
- Consumes: Task 9 components, the Task 4 and 6 views, and the Task 8 preview read.
- Produces:
  - Checkout layout: `BlockCanvas` with `slots.payment` = the existing payment UI (amount, payee line "You're paying {payee}" plus the "· trading as {trading_as}" line, timer, `PayFlow`, warnings) and `slots.orderSummary` = line items (image, name, qty, amount, and a "Shipping, tax or discounts" difference line when `Σ ≠ amount`). Expired, cancelled and held screens keep Tendr wording, styled only.
  - `<PayBar amount payee onActivate />`: shown on viewports ≤ 640 px while an `IntersectionObserver` reports the sealed section < 30% visible. It is `position: fixed; bottom: 0`. `onActivate` scrolls the sealed section into view and focuses its first control. It is hidden on status screens. Only Tendr CSS uses `position: fixed` (merchant CSS can't, Task 3).
  - **Success:** `success_blocks` canvas. `thank_you` shows `success_message` (default "Payment received — thank you."). `back_to_store` links to the session success URL. `Celebration` runs confetti or pulse once, and does nothing under `prefers-reduced-motion`.
  - **Link page:** the same canvas. The sealed section holds the amount input, note and Pay button. The `order_summary` slot shows the link title and description.
  - **Preview page:** fetches the public preview, renders the full canvas with sample data, shows a fixed "Preview — payments are off" ribbon, makes the Pay button inert, and applies `opts.scheme`. It sets `robots: noindex` in metadata and is added to the middleware matcher with the checkout CSP.
  - **CSP** (`csp.ts`):
    - `font-src 'self' <TENDR_ASSET_ORIGIN>` (drop `fonts.gstatic.com` once Tendr fonts move to `@fontsource` too);
    - `img-src 'self' data: blob: <TENDR_ASSET_ORIGIN>` plus the exact token-logo hosts the checkout uses today (check `TokenPicker` and `lib/checkout/api.ts` `logo_url`, e.g. CoinGecko). Any `https:` wildcard is removed;
    - `frame-src` adds `https://www.youtube-nocookie.com https://player.vimeo.com`;
    - `style-src` drops `fonts.googleapis.com`. Replace the Google Fonts `@import` in `globals.css` with `@fontsource` Instrument Sans and Sora.

- [ ] **Step 1: Failing tests**
  - `components.test.tsx`:
    - `payee line uses account name and trading as`;
    - `pay bar hidden on status screens`;
    - `success canvas renders thank you and back to store`;
    - `celebration skipped with reduced motion`.
  - `csp.test.ts`: `img-src has no https wildcard and includes asset origin`; `frame-src allows only the two video hosts`.
  - Playwright `e2e/themes.spec.ts`, at a 375×812 viewport, with themes seeded through the API on the e2e stack:
    - `themed checkout renders preset and pays in test mode`;
    - `hostile theme cannot cover or move the payment block`. Seed a theme whose CSS and HTML are as aggressive as the validator **allows** (big negative margins, `transform: translateY(-500px)`, `z-index: 99999`, a 3000 px-tall banner, absolutely positioned elements). Assert the sealed section's bounding box is not intersected by any `.tdr-wrap` box, that `elementFromPoint` at the amount's centre returns a node inside `.tdr-payment` once it is scrolled into view, and that the amount text equals the API amount.
    - `pay bar appears when payment block is off screen` (and hides after tapping);
    - `invalid stored theme falls back to default and checkout works`;
    - `preview page renders draft and cannot pay`;
    - `link page uses link theme_id`.
- [ ] **Step 2: Run** `npm test -w @tendr/web && E2E_STORE_PORT=3210 npm run e2e -w @tendr/web -- themes`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --concurrency=1` and `E2E_STORE_PORT=3210 npm run e2e -w @tendr/web`. Expected: all PASS, including the existing payment-links and checkout e2e specs.
- [ ] **Step 5: Commit** `feat(web): themed checkout, link page, pay bar and preview`.

### Task 11: WooCommerce plugin (line items, brand)

**Files:**
- Modify: `apps/woocommerce/includes/class-tendr-gateway.php` (`session_body` ~289-310), `apps/woocommerce/includes/class-tendr-connect.php` (after a successful token exchange ~303-312, and the settings screen), `apps/woocommerce/tendr-pay-with-crypto.php` (`TENDR_VERSION` and header `0.2.0`), `apps/woocommerce/readme.txt` (Stable tag `0.2.0`, changelog `= 0.2.0 =`), `apps/web/src/lib/plugin-update.ts` (version mirror), and the plugin's PHP tests (follow the existing test layout under `apps/woocommerce/tests`)
- Create: `apps/woocommerce/includes/class-tendr-brand.php`

**Interfaces:**
- Consumes: `PUT /v1/connection/brand` (Task 7) and the session `line_items` (Task 6).
- Produces:
  - `session_body()` adds `line_items`: for each order item (max 50, then stop), `name` (product name, ≤ 200), `quantity`, `unit_amount` (line total ÷ qty, formatted to the store currency's decimals), and `image_url` (the featured image's full URL, only if https).
  - `Tendr_Brand::collect(): array { site_name, logo_url?, icon_url?, palette[] }`:
    - `site_name` from `get_bloginfo('name')`;
    - `logo_url` from the `custom_logo` theme mod;
    - `icon_url` from `get_site_icon_url(512)`;
    - `palette` from `wp_get_global_settings(['color','palette','theme'])` slugs' colours, if available (WP ≥ 5.9), else empty.
  - `Tendr_Brand::send()` PUTs it with the connection key. It runs once right after connect succeeds, and from a "Refresh brand from my store" button on the plugin settings screen (nonce-protected, `manage_woocommerce`). Failure shows an admin notice and never blocks connect.

- [ ] **Step 1: Failing tests**
  - `truncates to 50 items`;
  - `line item unit amounts use store decimals`;
  - `skips non-https images`;
  - `brand collect reads logo, icon and palette`;
  - `refresh requires nonce and capability`.
- [ ] **Step 2: Run** the plugin test command used in project 4 (see `apps/woocommerce` README / composer scripts). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx turbo run test --filter=@tendr/web` (plugin-update mirror). Expected: PASS.
- [ ] **Step 5: Commit** `feat(woocommerce): send line items and store brand (0.2.0)`.

### Task 12: SDK, docs and handover

**Files:**
- Modify: `packages/sdk/src/client.ts`, `types.ts`, `client.test.ts`, `apps/docs/docs.json`, `apps/docs/api-reference/overview.mdx` (if it lists resources), `README.md`
- Create: `apps/docs/themes/overview.mdx`, `apps/docs/themes/safety-rules.mdx`, `apps/docs/api-reference/themes.mdx`, `docs/handover/2026-10-30-checkout-themes.md`

**Interfaces:**
- Produces (SDK):
  - `client.themes = { presets(), list(query), create(input, opts?), retrieve(id), update(id, input), delete(id), publish(id), setDefault(id), validate(document), preview(id, opts), fromWebsite(input), fromStore(input) }`;
  - `client.themeAssets = { upload({ kind, file: Blob, filename }), list(query), delete(id) }`. Upload uses `FormData`; the others follow the `paymentLinks` pattern.
  - Session create input types gain `theme_id` and `line_items`.
- Docs:
  - **"Branding your checkout":** presets; brand pull from WooCommerce and website; blocks (every type and its props); the sealed payment block and what themes can and can't change; light/dark/auto; fonts; preview; publish rules (live only, step-up); and the note that Tendr's own words stay in English until the languages project.
  - **"Theme safety rules":** every CSS and HTML rejection with its message; text rules; the accepted image-QR risk.
  - **API reference:** every endpoint and error code (`THEME_INVALID`, `THEME_IN_USE`, `THEME_LIMIT`, `ASSET_INVALID`, `ASSET_IN_USE`, `BRAND_FETCH_FAILED`), and the session `theme_id` / `line_items`.
- Handover note:
  - **Maps out** the API, storage and asset origin, the preview URL and the safety model.
  - **Suggests** editor screens: preset picker, brand-pull prompt, settings panel, drag-and-drop block list, CSS and HTML editors with inline problems from `/validate`, phone-frame preview using `/preview`, and publish with step-up.
  - States deploy needs:
    - the S3 bucket;
    - the `ASSET_S3_*` vars;
    - an https `TENDR_ASSET_ORIGIN`;
    - response headers on the asset origin: `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: cross-origin` (via an R2 transform rule).
- README: new env vars, the MinIO service, and the plugin 0.2.0 note.

- [ ] **Step 1: Failing SDK tests:** `themes.publish posts to publish path`, `themeAssets.upload sends multipart`, `session create passes line_items`.
- [ ] **Step 2: Run** `npm test -w @tendr/sdk`. Expected: FAIL.
- [ ] **Step 3: Implement** the SDK; write the docs, the handover note and the README.
- [ ] **Step 4: Run** `npx turbo run typecheck lint test --concurrency=1` and `npx mintlify broken-links` from `apps/docs` (as in 5b). Expected: PASS.
- [ ] **Step 5: Commit** `docs: checkout themes guide, api reference, sdk and handover`.
