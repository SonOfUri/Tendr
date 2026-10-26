<?php
/**
 * Plugin Name:          tendr: Pay with crypto
 * Plugin URI:           https://usetendr.tech
 * Description:          Take crypto payments in WooCommerce. They settle into your own tendr account; connect in one click, no keys to copy.
 * Version:              0.1.0
 * Requires at least:    6.4
 * Requires PHP:         8.0
 * Requires Plugins:     woocommerce
 * Author:               tendr
 * Author URI:           https://usetendr.tech
 * License:              GPL-2.0-or-later
 * License URI:          https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:          tendr
 * WC requires at least: 8.5
 * WC tested up to:      11.2
 *
 * @package Tendr
 */

defined( 'ABSPATH' ) || exit;

define( 'TENDR_VERSION', '0.1.0' );
define( 'TENDR_PLUGIN_FILE', __FILE__ );
define( 'TENDR_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

// Everything below the PHP check uses PHP 8 syntax, so the check comes first and stays PHP 5 safe.
if ( version_compare( PHP_VERSION, '8.0', '<' ) ) {
	add_action(
		'admin_notices',
		function () {
			if ( current_user_can( 'activate_plugins' ) ) {
				echo '<div class="notice notice-error"><p>' . esc_html__( 'tendr: Pay with crypto needs PHP 8.0 or later.', 'tendr' ) . '</p></div>';
			}
		}
	);
	return;
}

require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-plugin.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-credentials.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-api-client.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-connect.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-settings.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-order-status.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-webhooks.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-order-sync.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-refunds.php';
require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-test-purchase.php';

register_activation_hook( __FILE__, array( 'Tendr_Webhooks', 'activate' ) );
register_deactivation_hook( __FILE__, array( 'Tendr_Webhooks', 'deactivate' ) );

add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', TENDR_PLUGIN_FILE, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', TENDR_PLUGIN_FILE, true );
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		if ( class_exists( 'WC_Payment_Gateway' ) ) {
			require_once TENDR_PLUGIN_DIR . 'includes/class-tendr-gateway.php';
		}
		Tendr_Plugin::init();
	}
);
