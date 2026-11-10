=== tendr: Pay with crypto ===
Tags: woocommerce, payments, crypto, stablecoin, checkout
Requires at least: 6.4
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.3.3
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Accept crypto payments in WooCommerce with Tendr. Connect your business, choose settlement, and track payments and refunds.

== Description ==

tendr: Pay with crypto connects WooCommerce to Tendr's hosted payment service. Shoppers select Pay with crypto, complete payment on Tendr's checkout, and receive an updated WooCommerce order after a verified payment notification.

* Connect an existing Tendr business or create one in the Tendr sign-in flow; no API keys to copy.
* Supports classic checkout, Cart and Checkout blocks, and High-Performance Order Storage (HPOS).
* Choose a supported settlement asset in the Tendr dashboard.
* Send product details and your store's branding to the hosted checkout.
* Request refunds from WooCommerce and follow their approval and payment status.
* Use Test mode for simulated payments and Live mode for real payments.

= Tendr service and charges =

A Tendr account and connected business are required. Live payments require an active live wallet and settlement configuration. The plugin is free to install; Tendr service fees, network costs, and swap or withdrawal provider fees can apply. Review the fee settings and the quote displayed before authorizing a payment or withdrawal. Test mode is available to store managers and does not move real funds.

The plugin provides the WooCommerce integration. Tendr provides account connection, hosted checkout, payment sessions, settlement, refund coordination, and signed payment notifications. Uninstalling the plugin does not delete the Tendr account or move its funds.

= External services and data =

The plugin uses the following Tendr endpoints. The merchant starts the connection by clicking Connect to tendr and approving their business in Tendr. Activating this version alone does not contact Tendr or download plugin updates from Tendr.

* https://app.usetendr.tech — opens the sign-in and connection approval page and links to the merchant dashboard. Connection sends the site URL, callback URL, plugin version, platform identifier, and one-time connection parameters.
* https://api.usetendr.tech — exchanges the connection code, reads and updates connected-store settings, creates and checks payment sessions, requests and checks refunds, and disconnects the site. Payment requests include order references and order key, amount and currency, customer billing email when present, return URLs, product names, quantities, prices, and product image URLs. Brand sync sends the store name, logo/icon URLs, and theme colours after connection and when the merchant selects Refresh brand from my store. API requests include WordPress, WooCommerce, and plugin versions.
* https://pay.usetendr.tech — hosts the shopper's checkout and serves https://pay.usetendr.tech/v1/tendr.js on the order-payment screen. This service script opens the hosted payment UI in an iframe; a direct checkout link is available as a fallback. The browser sends the checkout session URL and normal connection information such as its IP address and user agent to the service. The checkout can ask the shopper for a wallet address, token, and network to carry out the payment.

The WordPress plugin calls Tendr directly. Tendr's hosted service uses payment infrastructure including NEAR Intents and 1Click to execute supported payments and withdrawals. The service's Terms and Privacy Policy describe its processing and providers. Blockchain transactions can be publicly observable; this plugin does not promise private transactions.

Service: https://usetendr.tech
Terms: https://usetendr.tech/terms
Privacy Policy: https://usetendr.tech/privacy

The plugin does not include advertising or analytics trackers. Its fonts, branding images, styles, and integration scripts are bundled locally; the hosted checkout service script is described above. Payment completion is verified server-side using signed webhook notifications, not a browser success message.

= Data stored on your WordPress site =

The plugin stores encrypted Tendr connection credentials, public connection details, payment mode, gateway settings, short-lived connection state and notices, and payment/refund references on WooCommerce orders. A plugin-owned table keeps webhook event identifiers and processing timestamps for duplicate prevention; entries are pruned after 30 days. Failed API calls can create redacted WooCommerce log entries. WooCommerce's order and log retention settings still apply.

Disconnect the site before uninstalling to revoke its Tendr keys. Uninstall removes the plugin's settings, connection credentials, event table, and scheduled event pruning. Existing WooCommerce orders, order notes, payment/refund references, and WooCommerce logs remain as part of the store's records. Removing the plugin does not erase records held by the Tendr service.

= Requirements =

* WordPress 6.4 or later, WooCommerce 8.5 or later, and PHP 8.0 or later with libsodium enabled.
* A publicly reachable HTTPS store for live use, with outgoing HTTPS access and incoming Tendr webhook requests allowed.
* Pretty permalinks (any structure other than Plain), using the standard /wp-json/ REST API prefix.
* WordPress admin and site addresses on the same origin.
* A Tendr account and a supported wallet/passkey setup for live settlement and approvals.

== Installation ==

1. Install and activate WooCommerce.
2. Install this plugin through Plugins > Add New > Upload Plugin, or through its WordPress.org listing after approval, and activate it.
3. Open WooCommerce > Settings > Payments > tendr > Manage.
4. Select Connect to tendr, sign in, and approve the business you want this site to use.
5. Review the connected business, payment mode, fee settings, and notification email.
6. Make a test purchase as a store manager. Complete live-wallet and settlement setup in Tendr, then switch the plugin to Live mode when ready.

== Frequently Asked Questions ==

= Do shoppers need a Tendr merchant account? =

No. Shoppers use the hosted checkout and its supported wallet or transfer options. The store owner needs a Tendr account to connect the business and manage its wallet.

= Does Test mode move money? =

No. Test payments are simulated. Only store managers see the payment method in Test mode. Live mode accepts real crypto and is shown to eligible shoppers.

= When is an order marked paid? =

The plugin verifies Tendr's signed payment notification and matches it to the stored order and payment session before updating the order. A redirect or browser message alone does not mark an order paid.

= Are refunds immediate? =

A WooCommerce refund request can require wallet-owner approval in Tendr. The plugin shows its pending status and records a completed refund after Tendr confirms execution. Review the Tendr dashboard for requests that need approval or attention.

= Where are my keys stored? =

The site's API and webhook credentials are encrypted in the WordPress options table using libsodium and a key derived from AUTH_KEY and SECURE_AUTH_KEY. Someone with access to both the database and wp-config.php could decrypt them. Changing those salts requires reconnecting Tendr. The plugin does not hold the merchant wallet's private signing key.

= What if my site address changes? =

Reconnect using the same Tendr business after moving the site. Tendr's connection-replacement flow can transfer the earlier connection's order notifications to the new connection. Check the settings page for any warnings about orders that still need attention.

= What happens to unpaid orders when I disconnect? =

Tendr attempts to close open checkouts. A payment already on its way can still settle, so review pending orders in Tendr. If the site cannot reach Tendr during disconnection, remove the site under Settings > Connected sites in the Tendr dashboard to revoke its keys.

= How are updates delivered? =

This version contains no custom updater. After the plugin is approved and released on WordPress.org, directory releases use WordPress's standard update mechanism. Until then, install an updated ZIP manually.

== Third-party assets and source ==

The PHP and JavaScript shipped in this package are readable source files and do not require a build step to run. Tendr's code and included logo assets are distributed under GPL-2.0-or-later; see LICENSE.txt. The logo artwork identifies the payment provider and does not imply WordPress or WooCommerce endorsement.

Sora and Instrument Sans are bundled under the SIL Open Font License 1.1. Their original notices and license texts are in assets/fonts/sora-LICENSE.txt and assets/fonts/instrument-sans-LICENSE.txt.

Sora source: https://github.com/sora-xor/sora-font
Instrument Sans source: https://github.com/Instrument/instrument-sans

== Changelog ==

= 0.3.3 =
* Restore Reconnect for connected stores, detect site address changes, and pause checkout until the connection has moved.
* Fall back to the same hosted payment session when an embedded checkout fails to load.

= 0.3.2 =
* Removes the Tendr-hosted plugin updater for WordPress.org distribution.
* Aligns the translation text domain with tendr-pay-with-crypto.
* Corrects plugin metadata and documents service endpoints, data handling, setup, fees, refunds, and uninstall behavior.
* Includes the GPL license and third-party font notices in the package.

= 0.3.1 =
* Refreshes the settings layout to match the Tendr dashboard, with clear connection, mode, preferences and appearance sections.
* Adds the Tendr logo to the settings page, WooCommerce payment method and payment handoff screen.
* Bundles brand images and fonts locally, with responsive layouts for desktop and mobile.

= 0.3.0 =
* Connects through app.usetendr.tech and opens checkouts on pay.usetendr.tech; the dashboard links point at the app host.
* While live mode is not open on tendr, the plugin stays in test mode and shows tendr's message.

= 0.2.0 =
* Sends the order's products (name, quantity, price, image) to the checkout page.
* Sends your store's name, logo and theme colours to tendr, to start a checkout theme from.

= 0.1.0 =
* Plugin scaffold, settings page and one-click Connect.
