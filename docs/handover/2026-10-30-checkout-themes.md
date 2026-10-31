# Checkout themes: handover note

Scope: how checkout themes work end to end, so the dashboard can be built on them. Public docs:
`apps/docs/themes/overview.mdx`, `apps/docs/themes/safety-rules.mdx` and
`apps/docs/api-reference/themes.mdx`. The dashboard UI is **not** built in this project.

Sections 1 and 2 are how the system works and what must be deployed. Section 3 is suggestion only.

## 1. How it works

### Data

- `CheckoutTheme` and `ThemeAsset` are **shared** models: one set per merchant, no `livemode`. Test
  and live mode see the same themes. A theme stores `draft` and `published` documents (JSON), the
  scoped `draftCss` / `publishedCss`, a `version` that rises on publish, and `isDefault`.
- A store holds at most 20 themes and 200 assets. Only one theme is default.
- Sessions and payment links point at a theme with `theme_id`. The sessions FK is
  `ON DELETE SET NULL (theme_id)` so old sessions never block deleting a theme (an old session
  re-rendered after deletion shows the default look). Payment links keep `RESTRICT`: a theme a link
  uses cannot be deleted (`THEME_IN_USE`, `details.links`).
- A theme document (`packages/contracts/src/themes.ts`): `settings`, `blocks`, `success_blocks`,
  optional `custom_css`. 22 block types, two containers (`columns`, `section`), three sealed or
  thank-you blocks (`payment`, `thank_you`, `back_to_store`).

### Merchant API

Routes: `apps/api/src/routes/themes.ts`, `theme-assets.ts`, `theme-brand.ts`,
`theme-preview-public.ts`. Logic: `apps/api/src/themes/`.

| Endpoint | Notes |
| --- | --- |
| `GET /v1/themes/presets` | Five presets rendered with the store name. |
| `GET/POST /v1/themes`, `GET/PATCH/DELETE /v1/themes/:id` | CRUD. PATCH takes `name` and/or `draft`. |
| `POST /v1/themes/validate` | `{ document }` returns `{ valid, problems: [{ path, message }] }`. |
| `POST /v1/themes/:id/preview` | `{ sample, scheme, viewport }` returns `{ url, expires_at }` (201). |
| `POST /v1/themes/:id/publish`, `/default` | Live key or stepped-up dashboard user. |
| `POST /v1/themes/from-website`, `/from-store` | Create a draft from brand. Limiter `brand_pull`, 10 per store per hour. |
| `PUT /v1/connection/brand` | Connection key only (WooCommerce plugin 0.2.0). Stores site name, logo and icon URLs, palette. |
| `POST/GET /v1/theme-assets`, `DELETE /v1/theme-assets/:id` | Multipart upload. |
| `GET /v1/themes/preview/:token` | Public, no credential; the shopper-side read for previews. |

- **Principals.** A secret key (scopes `themes:read` / `themes:write`) or a dashboard user
  (`account:read` to read, `settings:manage` to write).
- **Publish and default** (`liveCtxOf`): a live key, or a dashboard user with `settings:manage` and
  step-up (`requireStepUp`). A test key gets `403 FORBIDDEN`. Drafts, uploads, previews, validation
  and brand pulls work in either mode.
- **Errors**: `THEME_INVALID` (400, `details.problems`), `THEME_LIMIT` (409), `THEME_IN_USE` (409,
  `details.reason` of `default`, `links` or `referenced`), `ASSET_INVALID` (400, includes the 200 asset limit),
  `ASSET_IN_USE` (409, `details.themes`), `BRAND_FETCH_FAILED` (422, `details.reason` is a
  `SafeFetchReason`).
- **Uploads** are read whole into `req.rawBody` and parsed with busboy, so request signing and
  `Idempotency-Key` hashing cover the real bytes. The request cap is 2 MB plus framing.
- **Brand pulls** go only through `safeFetch` (https, no private addresses, 5 s timeout, 2 MB, at
  most 3 redirects). They create drafts and never publish.

### Safety model

Everything a theme can contain is checked **on save** and again **on render**.

- **Save** (`validateThemeDocument`, `apps/api/src/themes/validate.ts`): schema, palette contrast
  (text/background and text/surface at least 4.5, accent/background at least 3, for every palette),
  asset references, custom HTML (sanitised, the cleaned HTML is what is stored) and custom CSS
  (`css.ts`: parsed, every rule scoped under a per-theme class, rejected on any escape).
- **Text rules** (`packages/contracts/src/theme-text.ts`): address-like text, "send to" phrasing,
  countdown labels, button words.
- **Render**: blocks are clipped and isolated (`contain: layout paint`, `isolation: isolate`), the
  payment block is sealed, and a theme that is missing, invalid or unparsable falls back to the
  Tendr default theme. The API logs a warning; payment never fails because of a theme.
- **Live vs test.** A live session renders only the **published** version. A test session may name
  a draft theme and renders the draft; an open test session shows draft edits after a reload.
- **Mid-payment republish.** A republish changes only theme fields on the shopper's next poll or
  refresh; amount, address, timer and status are unchanged.

Rulings made during the build, which the docs reflect:

- CSS cannot draw any text. `content` accepts only `none`, `normal`, `""`, quote keywords,
  `counter(ident)` and `url(asset)`. Counters and list markers are digits or bullets only; counter
  numbers are limited to -999 to 999. `attr()` is refused, `var()` in text properties is refused.
- `@import`, `@font-face`, `position: fixed|sticky`, `url()` outside the asset origin, `<` anywhere
  in CSS, and the reserved `tdr-` / `pay-` names are refused. A top-level `*` is refused (a longer
  selector such as `.card *` is fine).
- The `button_label` applies to the **main Pay button only**. `{amount}` is the only placeholder
  and is filled by Tendr.
- The web shows the theme's `display_name` wherever the store name was shown outside the sealed
  block. The sealed payee line uses the account name: "You're paying *account name*", plus
  "*account name* · trading as *display name*" when the two differ (`namesMatch`).
- Data-scheme colours (native controls, Tendr's warning and timer colours) follow the active
  palette background's luminance (under 0.4 is dark), not just the mode.
- The Tendr default theme's dark accent is `#7a72ff`; the light palette keeps `#4035f5`.
- The sealed amount is set in Sora (a Tendr font).

**Accepted residual risks.** Address detection is best effort. Not detectable:

1. Address-like text split by hidden elements (`display: none`, zero font size spans) or by
   punctuation.
2. An image showing a fake QR code or address.
3. A video showing a fake QR code or address (like images, Tendr does not inspect what it shows).

The defence, and the source of truth, is the sealed block: it always shows the real address and QR in Tendr's fonts and states
that funds go only there.

Button words and currency codes (ruling R5): any ISO 4217 code written ALL-CAPS as a whole word is
refused (`TRY`, `ALL`), and the major codes USD EUR GBP NGN KES GHS ZAR CAD AUD JPY CNY INR BRL are
refused in any case (`usd`). Everyday words that are also codes (`Try`, `all`, `top`, `cup`) pass.
The message names the refused word.

### Assets and the asset origin

- Uploads are validated by content, rasters are re-encoded (PNG, JPEG, WebP, GIF, 2 MB), SVG is
  sanitised (512 KB), fonts are `.woff2` (500 KB). Stored at
  `assets/<merchant id>/<asset id>.<ext>` in an S3-compatible bucket and served from
  `TENDR_ASSET_ORIGIN`.
- Product images from `line_items` are fetched through `safeFetch`, validated, re-encoded and cached
  on the same origin. Shoppers never load images from the merchant's own host. The work runs on its
  own BullMQ queue (`tendr-product-images`, 2 jobs at once), never the shared events queue: each
  job fetches 3 images at a time, skips failures from the last hour, and starts no fetch after
  30 s (the rest stay `pending` for a later session).
- The web CSP allows images and fonts from `TENDR_ASSET_ORIGIN` only
  (`apps/web/src/lib/csp.ts`, applied by `apps/web/src/middleware.ts`).

### Preview

`POST /v1/themes/:id/preview` stores a preview in Redis for 15 minutes under `theme-preview:<sha256
token>` and returns `CHECKOUT_BASE_URL/preview/theme/<token>`. The page fetches the public read
client-side, so no internal-client change was needed. The link needs no credential, shows the
**draft** with sample data (a sample cart, or a sample link page), is `no-store`, `noindex`, and
never creates a session.

### Sessions and line items

`POST /v1/checkout/sessions` accepts `theme_id` (404 if not the merchant's) and `line_items` (up to
50; each `name`, `quantity`, `unit_amount`, optional `image_url`, `description`). The session stores
them for the order summary and rejects a `unit_amount` with more decimals than the currency allows.
Address-like names render masked. Failed or private-address images show no picture. Payment links
take `theme_id` on create and update.

### WooCommerce plugin 0.2.0

Sends line items (exact unit prices when the line total divides evenly at the store's decimals,
otherwise quantity 1 with a "Name × n" line total), truncated to 50, and retries once without line
items if the API answers 400 about `line_items`, so checkout never fails over display data. It also
sends the store's brand (name, logo, icon, palette) to `PUT /v1/connection/brand` on connect and
on **Refresh brand from my store**; the dashboard can then offer `POST /v1/themes/from-store`.

## 2. Deploy needs

| Need | Detail |
| --- | --- |
| Object storage | An S3-compatible bucket, publicly readable. Cloudflare R2 is the target. |
| `ASSET_STORE_DRIVER=s3` | Required in production (`memory` is refused there). Defaults to `memory` outside production. |
| `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY` | Required when the driver is `s3`. |
| `ASSET_S3_ENDPOINT`, `ASSET_S3_REGION`, `ASSET_S3_FORCE_PATH_STYLE` | R2 endpoint (`https://<account>.r2.cloudflarestorage.com`), region `auto`, path style `false`. Local MinIO uses path style `true`. |
| `TENDR_ASSET_ORIGIN` | An **https** URL in production (the API refuses to boot otherwise). It is the public base of the bucket, with a path prefix when the bucket has one. Set it in the **API and the web app**. |
| Postgres 15 or newer | The sessions FK uses `ON DELETE SET NULL (theme_id)`, which needs Postgres 15 (column list). |
| Response headers on the asset origin | See below. |

All of the vars are in `turbo.json` `globalPassThroughEnv`, `.env.example` and
`apps/api/src/env.ts`. Never store them in Postgres.

**`TENDR_ASSET_ORIGIN` in the web app.** `apps/web/src/middleware.ts` reads
`process.env.TENDR_ASSET_ORIGIN` on every request to build the checkout CSP. Under `next start` the
middleware reads it at request time, from the web app's runtime environment, so set it there; a
change takes effect on restart. Setting it in the build environment too is harmless. (`og-logo.ts`
reads it at runtime from the Node route as well.)

**Response headers on the asset origin.** The bucket serves merchant-uploaded files, so the origin
must add these to every response, with an R2 transform rule (Rules, Transform Rules, Modify Response
Header) on the asset hostname:

```
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'
Cross-Origin-Resource-Policy: cross-origin
```

For SVG responses (`*.svg`) also send `Content-Security-Policy: sandbox; default-src 'none'; img-src
'self'; style-src 'unsafe-inline'` (the `sandbox` token stops scripts and top-level navigation if
the file is opened directly). `Cross-Origin-Resource-Policy: cross-origin` lets the checkout page,
which is on another origin, load the images and fonts.

**CORS on the asset bucket.** Browsers fetch web fonts in CORS mode, so an uploaded `.woff2` font
fails to load on the checkout page unless the asset origin answers with
`Access-Control-Allow-Origin`. Add a CORS rule on the bucket (R2: bucket Settings, CORS policy)
allowing `GET` (and `HEAD`) from the checkout origin(s), for example:

```json
[{ "AllowedOrigins": ["https://checkout.tendr.example"], "AllowedMethods": ["GET", "HEAD"] }]
```

or send `Access-Control-Allow-Origin: <checkout origin>` (plus `Vary: Origin` when there is more
than one) with the same transform rule as the headers above. Images do not need it.

**Prisma and the FK.** `schema.prisma` keeps `onDelete: Restrict` on `Session.theme` with a comment,
because Prisma cannot express `ON DELETE SET NULL (theme_id)`. The migration changes the FK by hand.
A later `prisma migrate dev` diff will try to put `Restrict` back. Review such a diff and drop that
statement.

**Local MinIO.** `infra/docker/docker-compose.yml` has `minio` and `minio-init` services, but
Docker Hub no longer serves `minio/minio` or `minio/mc` ("pull access denied"). Until a
replacement image (or a real R2 dev bucket) is chosen, local runs use the default
`ASSET_STORE_DRIVER=memory`; the S3 path has only been exercised against the in-process store.
Choosing the image is a security decision for the project owner.

## 3. Suggested editor screens (suggestion only)

None of this is built. The dashboard team is free to shape it.

1. **Theme list.** `GET /v1/themes`: name, status badge (draft or published), default badge,
   `used_by_links`, last published. Actions: duplicate (`create` with `from.theme_id`), delete (explain
   `THEME_IN_USE`), make default.
2. **New theme.** A preset picker from `GET /v1/themes/presets` (render each preset's `document`
   as a thumbnail) and a **Brand pull** prompt: "Use your website" (URL field, `from-website`) or
   "Use your WooCommerce store" (list connections, `from-store`). Show `BRAND_FETCH_FAILED` with the
   `reason` in plain words and offer a preset instead.
3. **Settings panel.** Name, logo (upload through `theme-assets`), light/dark/auto, palettes with live
   contrast feedback, font (curated list or `.woff2` upload), corner style, button words (explain
   `{amount}` and the no-numbers rule), success message, celebration, support and terms URLs.
4. **Block list.** A drag-and-drop list for `blocks` and another for `success_blocks`. The `payment`
   block is pinned, cannot be removed, and cannot be moved into a container. Add-block menu with the
   22 types; prop forms per type; `columns` and `section` hold leaf blocks only.
5. **CSS and HTML editors.** Debounce a call to `POST /v1/themes/validate` and map each problem's
   `path` to the field (`custom_css` problems start with `Line N:`, so place the marker on that
   line; `blocks.N.html` maps to the block). Link to the safety rules page.
6. **Phone-frame preview.** Call `POST /v1/themes/:id/preview` after each save (links last 15 minutes,
   so re-mint on demand) and load the `url` in an iframe sized to a phone, with a sample
   (checkout/link), scheme (light/dark) and viewport (phone/desktop) switch.
7. **Publish.** A Publish button that shows a diff summary between `draft` and `published`, asks for
   step-up, then calls `publish`. In test mode, explain that publishing needs a live key and that
   test sessions already show the draft. "Make default" is a separate action with the same step-up.
8. **Assets.** A grid from `GET /v1/theme-assets` with usage warnings; deleting an asset shows
   `ASSET_IN_USE` with the theme names.

## 4. Things the dashboard will meet

- Test and live modes share themes. A theme edit does not touch live shoppers until publish.
- `status` is `draft` before the first publish, then stays `published`; compare `draft` with
  `published` to know whether there are unpublished edits.
- Every save returns the full normalised document (custom HTML replaced by its cleaned form). Show
  the returned value, not the one you sent.
- Theme names are limited to 80 characters; block ids must be unique across `blocks` and
  `success_blocks`.
