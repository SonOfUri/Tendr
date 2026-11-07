# Local WordPress store connected to Tendr

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
the Storefront theme and Tendr 0.3.0 from the local release ZIP. It creates a **$1 virtual product**,
enables pretty permalinks and guest checkout, and uses USD. Subsequent starts retain orders,
products, configuration and Tendr connections. The Tendr plugin is refreshed from this checkout.

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
same tunnel during an in-progress payment. Before retiring the store, disconnect it or revoke
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
