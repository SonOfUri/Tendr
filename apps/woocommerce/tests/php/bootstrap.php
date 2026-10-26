<?php
/**
 * PHPUnit bootstrap: the WordPress test library (wp-env's tests environment) with WooCommerce and
 * this plugin loaded as must-use plugins.
 *
 * @package Tendr
 */

$tendr_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $tendr_tests_dir ) {
	$tendr_tests_dir = '/wordpress-phpunit';
}
if ( ! file_exists( $tendr_tests_dir . '/includes/functions.php' ) ) {
	fwrite( STDERR, "The WordPress test library is not at {$tendr_tests_dir}. Run the tests in wp-env: npm run test:php --workspace=@tendr/woocommerce\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
	exit( 1 );
}

require_once dirname( __DIR__, 2 ) . '/vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php';
require_once $tendr_tests_dir . '/includes/functions.php';

tests_add_filter(
	'muplugins_loaded',
	static function () {
		$plugins = defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : ABSPATH . 'wp-content/plugins';
		require $plugins . '/woocommerce/woocommerce.php';
		require dirname( __DIR__, 2 ) . '/tendr-pay-with-crypto.php';
	}
);

// WooCommerce installs its tables and roles (shop_manager has manage_woocommerce).
tests_add_filter(
	'setup_theme',
	static function () {
		WC_Install::install();
		$GLOBALS['wp_roles'] = null; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		wp_roles();
	}
);

require $tendr_tests_dir . '/includes/bootstrap.php';
require __DIR__ . '/class-tendr-test-case.php';
