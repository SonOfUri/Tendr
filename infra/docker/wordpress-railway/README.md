# WordPress on Railway

This image hosts the existing WooCommerce concept store independently of the local Mac.
It includes WP-CLI and a MariaDB client for maintenance over Railway SSH.

- Store: <https://wordpress-store-production-d4cb84af.up.railway.app/>
- Admin: <https://wordpress-store-production-d4cb84af.up.railway.app/wp-admin/>
- The migrated administrator username/password are unchanged. The private local record is
  `.keyvault/wordpress-store/credentials.json`.

The November 10, 2026 migration restored 13 published products, seven orders and one checkout
draft, the fashion theme, media and Tendr 0.3.3. The local Docker copy is retained as a fallback;
its crypto gateway is disabled for new orders after the migration. Use Railway for new work.

## Services and storage

The `tendr` project in the HODL workspace uses the `production` environment:

| Service | Image | Persistent mount | Resource limit |
| --- | --- | --- | --- |
| `wordpress-store` | This Dockerfile | `/var/www/html` | 1 GB RAM, 1 vCPU |
| `wordpress-db` | `mariadb:12.3.3` | `/var/lib/mysql` | 0.5 GB RAM, 0.5 vCPU |

Only WordPress has a public HTTPS domain. MariaDB is reachable through Railway private
networking. Volumes and actual compute/network usage are billed by Railway; these limits
are ceilings, not a monthly price or reserved capacity. Keep both services awake and at one
replica. Neither service can be recreated safely without its volume and configuration.

WordPress service settings:

- Dockerfile: `Dockerfile`; build context: this directory.
- Healthcheck: `/health`, timeout 180 seconds; public target port: `80`.
- Restart policy: `ON_FAILURE`, maximum 10 retries.
- Run as root (`RAILWAY_RUN_UID=0`) so the official image can initialize the volume and
  Apache can bind port 80; Apache workers run as `www-data`.
- Use the image entrypoint and command. It enables only Apache's prefork MPM at startup,
  including when image extraction restores a second MPM's symlinks.

The healthcheck confirms Apache/PHP liveness. Verify the storefront and database separately
after deployments. Service settings are persisted in Railway; this directory intentionally
does not rely on the deprecated `railway.json` configuration format.

MariaDB start command:

```sh
docker-entrypoint.sh mariadbd --bind-address=:: --innodb-buffer-pool-size=128M --max-connections=30 --performance-schema=OFF
```

## Variables and secrets

Set `MARIADB_DATABASE=tendr_store`, `MARIADB_USER=tendr_store`, and separate strong
`MARIADB_PASSWORD`/`MARIADB_ROOT_PASSWORD` values on `wordpress-db`.

On `wordpress-store`, use:

```text
WORDPRESS_DB_HOST=${{wordpress-db.RAILWAY_PRIVATE_DOMAIN}}:3306
WORDPRESS_DB_NAME=tendr_store
WORDPRESS_DB_USER=tendr_store
WORDPRESS_DB_PASSWORD=${{wordpress-db.MARIADB_PASSWORD}}
PORT=80
RAILWAY_RUN_UID=0
```

Preserve all eight `WORDPRESS_*_KEY` and `WORDPRESS_*_SALT` variables when migrating or
restoring the store. Tendr's saved credentials depend on the WordPress security keys.
Never commit credentials, SQL dumps, the source `wp-config.php`, or a content backup.
The local migration records and encrypted-credential dependencies are in the ignored
`.keyvault/wordpress-store/` directory with owner-only permissions.

`WORDPRESS_CONFIG_EXTRA` sets PHP/WP memory limits, `WP_ENVIRONMENT_TYPE=staging`,
`DISALLOW_FILE_EDIT=true`, and `FORCE_SSL_ADMIN=true`. Disable WP-Cron while importing a
clone; re-enable it after the migration. This remains a demo catalog even when Tendr uses
Live payments. Outgoing WordPress email/SMTP requires separate configuration.

## Deploy an image update

Use a current Railway CLI and authenticate with your own account. From this directory:

```sh
railway up . --path-as-root \
  --project a2f21ff5-5b3e-49f1-beb7-8990234aeca8 \
  --environment production --service wordpress-store
```

Upload only this directory. Its Docker build excludes unrelated files and secrets. Image
deployment preserves the WordPress volume: it does **not** refresh an existing theme,
plugin or WordPress core. Update those through WordPress admin or WP-CLI after taking a
backup. The fashion theme is copied into this volume, unlike the local Compose bind mount.

For maintenance:

```sh
railway ssh --project a2f21ff5-5b3e-49f1-beb7-8990234aeca8 \
  --environment production --service wordpress-store
wp --allow-root --path=/var/www/html plugin list
```

## Backups and restores

Back up both the database and WordPress files, and retain the eight salts separately in
secure storage. Enable Railway volume backups according to the desired retention policy;
the initial migration also has a local pre-migration backup. Do not assume a deployment
backup includes the database or volume files.

Export SQL with WP-CLI into a private directory outside `/var/www/html`, and download it
using authenticated Railway SSH/SFTP. Archive `wp-content` and `.htaccess` as well. Verify
archive integrity and checksums before restoring. Remove temporary remote exports afterward.
Never place backups under the web root or make the database publicly accessible to transfer
them.

For a restore, stop new checkouts and scheduled jobs first. Restore into an empty database
and volume (or explicitly plan a rollback of the existing store). Keep the target's generated
`wp-config.php`: it reads Railway's database variables and salts. Import SQL with
`wp --allow-root --path=/var/www/html db import /private/path/backup.sql`, extract the content
archive, and set ownership to `www-data:www-data`.

Update only WordPress's `home` and `siteurl` options to the new HTTPS address. If content
URLs need replacing, target `wp_posts` and `wp_postmeta`, skipping `guid`. Do not perform
a blanket options-table replacement: `tendr_connection.site_url` must retain its previous
value so the plugin detects the move and requires Reconnect.

Before opening checkout, verify product/order counts, images, cart, admin access, HTTPS,
and readable Tendr credentials. Confirm that a redeploy retains data. Re-enable WP-Cron
once the target is ready, and retire the old copy after Tendr's connection handover.

## Tendr after a domain change

Sign in with the existing WordPress administrator account. Go to **WooCommerce → Settings
→ Payments → tendr**, choose **Reconnect**, and authorize the same Tendr store with your
login passkey. Keep the existing connection until that flow completes: Reconnect hands
earlier orders and their webhooks to the new connection. Do not disconnect first.

Reconnect starts in Test mode. Choose **Live** again after readiness checks succeed.
Until Reconnect, the plugin intentionally pauses crypto checkout at the new address.
Do not modify the saved connection URL or copy API keys to bypass this check. Verify a
funded payment only when the owner chooses to perform one.
