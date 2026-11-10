# WordPress store connected to Tendr

The [hosted store](https://wordpress-store-production-d4cb84af.up.railway.app/) runs on Railway
with persistent WordPress and MariaDB volumes, independently of the local Docker setup.
The [WordPress admin](https://wordpress-store-production-d4cb84af.up.railway.app/wp-admin/) uses
the existing administrator credentials. Use the hosted store for new orders; the local copy is
retained as a fallback with its crypto gateway disabled after migration.
See the [Railway deployment and migration runbook](../infra/docker/wordpress-railway/README.md)
for service settings, image updates, backups, and the required Tendr Reconnect after a domain move.

## Local development

This runs a real WordPress/WooCommerce store in Docker, with Tendr's packaged plugin installed.
The plugin uses the deployed API, app and checkout hosts. Its connection starts in Test mode;
choosing Live after connection uses real funds. The launcher never connects an account or pays
an order automatically.

## Start the store

Docker, Node 22+ and this checkout are required:

```bash
npm run dev:wordpress
```

The first run installs WordPress 7.1.3, PHP 8.3, WooCommerce 11.2.1 (the plugin's tested version),
the Storefront theme and Tendr 0.3.3 from the local release ZIP. It creates a **$1 virtual product**,
enables pretty permalinks and guest checkout, and uses USD. Subsequent starts retain orders,
products, configuration and Tendr connections. The Tendr plugin is refreshed from this checkout.
An existing active theme is retained on restart.

Tendr's plugin settings use the frontend dashboard's monochrome theme, with Sora and Instrument
Sans bundled locally. The black and white marks come from the frontend team's `apps/web/public/tendr-logo-black.png`
and `tendr-logo.png` on `deploy`; both are packaged with the plugin. The logo also appears in classic
and Blocks checkout and on the payment handoff screen. Plugin styling stays scoped to Tendr's controls.

## Fashion concept storefront

The local store now has an optional **unofficial Zara-inspired concept**: editorial homepage,
six original concept clothing products, thirty size variations, six accessories/fragrances,
search, category navigation, and styled product/cart/checkout pages. It uses a Storefront child theme; WooCommerce and Tendr
continue to process carts and payments.

To apply or reapply it to an initialized local store:

```bash
npm run dev:wordpress:style
```

The command updates the twelve `TENDR-FASHION-*` products and its own pages, reuses imported images,
and selects the child theme. It retains existing orders and Tendr credentials/mode. Reapplying
resets these demo products to their seeded descriptions, prices and sizes. The original $1 item
remains purchasable through the footer but is hidden from the fashion catalog.

The catalog now also includes an $18 canvas tote, $9 hoop earrings, $15 sunglasses, $7 Citrus Mist
body spray, $24 Amber Woods perfume, and **$1 Neroli pocket perfume**. These are simple products
with no clothing-size selector. The $1 perfume appears first in the default shop ordering and
in the homepage's “The finishing touches” section, with a direct link in the strip beneath the hero.
Accessories and Fragrance have their own navigation entries and category pages.

Theme source: [`infra/docker/wordpress-store/fashion-theme`](../infra/docker/wordpress-store/fashion-theme).
The Compose services mount it read-only, so edit the repository rather than the WordPress theme
editor. Product seeding lives in [`fashion-setup.php`](../infra/docker/wordpress-store/fashion-setup.php).
The original imagery was generated with the built-in image tool; all thirteen optimized assets and
their exact [prompt set](../infra/docker/wordpress-store/fashion-theme/assets/prompts.json) are
committed with the theme. This is a concept catalog, not official Zara inventory or photography.

All fashion variations and accessories/fragrances are virtual demo items so they can exercise
checkout without inventing a fulfillment service. Nothing ships. The storefront and checkout state this explicitly; Live
payment mode still moves real funds. The styling command does not connect, change mode, or pay.

A private database backup from before the initial makeover is retained in
`.keyvault/wordpress-store/backups/before-fashion-2026-11-09.sql`. Do not publish it.

Preview checks cover desktop/mobile layouts, twelve catalog products, size selection, adding to the
bag, cart/checkout rendering, search and category navigation. No payment is submitted by these checks.

## Local access and credentials

- Initial storefront: `http://localhost:8894`.
- Admin: `http://localhost:8894/wp-admin/`, username `tendradmin`.
- The generated password is in `.keyvault/wordpress-store/credentials.json` (owner-readable,
  Git-ignored). Do not paste this file into chat or commit it.
- WordPress and MariaDB have separate persistent Docker volumes in the `tendr-wordpress` project.
  Only WordPress port 8894 is exposed, on loopback; the database has no host port.
- Keep the credential file, database and WordPress volume together. The WordPress salts in
  `wp-config.php` protect the plugin's connection secrets; replacing them requires reconnecting.

This store is separate from the `wp-env` environments and automated test databases. Do not point
the destructive WooCommerce E2E suite at it. The admin's placeholder email is `admin@example.invalid`;
outgoing store email/SMTP has not been configured.

## Give the store a reachable HTTPS address

Production Tendr requires HTTPS for Connect and a publicly reachable webhook endpoint. A localhost
address cannot receive Railway webhooks. For temporary testing, in another terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:8894
```

Keep that process running. Copy its generated HTTPS origin, then set both WordPress addresses:

```bash
npm run dev:wordpress -- --url https://YOUR-GENERATED-HOST.trycloudflare.com
```

Use that HTTPS address for both the storefront and admin from then on. The official WordPress
image recognizes the tunnel's forwarded HTTPS header. No TLS verification bypass is needed.
The store becomes publicly reachable; its admin still requires the generated password. WordPress
discourages indexing, but that is not access control.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
need no account or domain, have no uptime guarantee, and receive a new hostname after a restart.
Keep Docker, the tunnel and the computer running while testing payment updates. A stable hostname
and dependable hosting are needed for a permanent customer store.

## Connect your existing Tendr store

1. Use the dedicated **Local dashboard · Live API** Chrome window. The public app domain is still
   an operator issue as of November 7; this window serves the Tendr app locally at its approved
   origin. If necessary, start `npm run dev:console:live` or reopen its running window with
   `npm run dev:console:live -- --open`.
2. In that same window, open the WordPress HTTPS `/wp-admin/` and sign in with the credentials above.
3. Open **WooCommerce → Settings → Payments → tendr**. Direct path:
   `/wp-admin/admin.php?page=wc-settings&tab=checkout&section=tendr`.
4. Click **Connect to tendr**. In its popup, select your existing Tendr store and approve with
   your login passkey. The plugin receives its own keys and webhook secrets server to server;
   no manual API-key copy is needed. Approving also registers this site's checkout origin.
5. Back in WordPress, confirm the connected store, then select **Live** when ready. The plugin
   checks the backend account and payout readiness before switching. In Test mode, only store
   managers see Tendr at checkout, and payments are simulated.
6. Buy the virtual test product when you choose to perform a funded test. Check the WooCommerce
   order, the Tendr payment and the resulting wallet balance. A checkout popup closing is not
   evidence of payment; signed webhook processing determines the order's paid status.

If the tunnel hostname changes, run the `--url` command again, sign in at the new origin and click
**Reconnect** using the same Tendr store. The plugin has a connection-replacement flow for earlier
orders; merely changing WordPress's URL does not update Tendr's registered webhook URL. Keep the
same tunnel during an in-progress payment. From 0.3.3, a changed site address pauses crypto checkout
and shows a Reconnect notice. Use Reconnect without disconnecting first: it preserves the old
connection credentials for the order hand-over. Reconnecting starts in Test mode, so select Live
again after the readiness check. Before retiring the store, disconnect it or revoke
its connection from the Tendr dashboard.

## Stop or return to local-only access

Stop the tunnel with Ctrl+C, then stop the Docker services without deleting data:

If the initial setup launched the tunnel in the background, its log and PID are in
`.keyvault/wordpress-store/tunnel.log` and `tunnel.pid`. Stop that process with
`kill "$(cat .keyvault/wordpress-store/tunnel.pid)"` instead of Ctrl+C.

```bash
npm run dev:wordpress -- --stop
```

Start again with `npm run dev:wordpress`. The saved WordPress address remains unchanged. For
local-only browsing, after starting:

```bash
npm run dev:wordpress -- --url http://localhost:8894
```

Live Connect and incoming webhooks require restoring a reachable HTTPS address. Avoid
`docker compose down -v`: it deletes this store's database and WordPress files.

For direct WP-CLI inspection (do not dump stored secrets):

```bash
docker compose --env-file .keyvault/wordpress-store/compose.env \
  -f infra/docker/wordpress-compose.yml run --rm cli wp plugin list
```

The setup uses the [official WordPress Docker images](https://hub.docker.com/_/wordpress),
including WP-CLI with the matching WordPress volume user (`33:33`).
