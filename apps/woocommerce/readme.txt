=== tendr: Pay with crypto ===
Contributors: tendr
Tags: woocommerce, payments, crypto, stablecoin, checkout
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.2.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Take crypto payments in WooCommerce. They settle into your own tendr account. Connect in one click, with no keys to copy.

== Description ==

tendr: Pay with crypto adds a crypto payment method to WooCommerce. Payments settle non-custodially into your store's own tendr account, in the token you chose.

Setup is one click: **Connect to tendr** opens a window on usetendr.tech where you sign in or sign up, pick or create a store, and approve with your passkey. The plugin then receives its own keys directly from tendr. You never see or copy a secret key.

= External service =

This plugin talks to the tendr service, run by tendr:

* `https://api.usetendr.tech` — the tendr API. The plugin calls it to finish connecting (exchanging a one-time code for this site's keys), to disconnect, and, in later versions, to create checkouts and refunds. It sends this site's address, the WordPress, WooCommerce and plugin versions (in the User-Agent), and order details needed for a payment.
* `https://usetendr.tech/connect` — the Connect window, opened in your browser when you click Connect.

Terms: https://usetendr.tech/terms — Privacy: https://usetendr.tech/privacy

The plugin does not track you and does not call any other service.

= Requirements =

* WordPress 6.4 or later, WooCommerce 8.5 or later, PHP 8.0 or later.
* Pretty permalinks (any structure other than Plain): tendr sends payment updates to `/wp-json/tendr/v1/webhook`.
* The WordPress admin and the site on the same address (origin).

== Frequently Asked Questions ==

= Where are my keys stored? =

In the WordPress options table, encrypted (libsodium secretbox) with a key derived from your site's `AUTH_KEY` and `SECURE_AUTH_KEY` salts. They are never shown in the admin or sent to the browser. As with any WordPress plugin, someone with access to both your database and `wp-config.php` could decrypt them. If the salts change, the plugin asks you to reconnect. If the salts are missing, empty or still WordPress's sample phrase, the plugin refuses to connect until you set unique ones (https://api.wordpress.org/secret-key/1.1/salt/), since keys encrypted under public salts would not be protected.

= What if my site address changes? =

Orders keep updating: each order is matched by the reference stored on it, never by the site address. Click **Reconnect** (or Connect) on the tendr settings page after the move; the plugin hands the earlier connection's orders and refunds to the new one, so payments and refunds for orders placed before the move still reach this site.

= What happens to unpaid orders when I disconnect? =

tendr closes their open checkouts. A payment already on its way still lands in your tendr account, but this site is no longer told; the plugin adds a note to each order still waiting, and the Disconnect confirmation says how many there are.

= What happens when I uninstall the plugin? =

Uninstalling deletes the plugin's settings, stored keys and its table of processed payment updates from WordPress. It does not contact tendr, so click **Disconnect** first to revoke this site's keys, or remove the site later under Settings → Connected sites on your tendr dashboard.

== Changelog ==

= 0.2.0 =
* Sends the order's products (name, quantity, price, image) to the checkout page.
* Sends your store's name, logo and colours to tendr, with a "Refresh brand from my store" button.

= 0.1.0 =
* Plugin scaffold, settings page and one-click Connect.
