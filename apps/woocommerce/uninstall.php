<?php
/**
 * Uninstall: delete the plugin's options and transients.
 *
 * This does not call tendr: the site's keys stay active on tendr until the store removes the site
 * under Settings → Connected sites on the tendr dashboard (or Disconnect is clicked before
 * uninstalling, which revokes them).
 *
 * @package Tendr
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

foreach ( array( 'tendr_credentials', 'tendr_connection', 'tendr_mode', 'woocommerce_tendr_settings' ) as $tendr_option ) {
	delete_option( $tendr_option );
}

// The processed-events table, its version option and the daily prune.
require_once __DIR__ . '/includes/class-tendr-webhooks.php';
Tendr_Webhooks::uninstall();

// Connect state (keyed by a hash of the state) and per-user notices: `tendr_connect_*`, `tendr_notice_*`.
// With a persistent object cache these live in the cache instead and expire on their own (≤ 60 min).
global $wpdb;
$tendr_names = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- transients keyed by a hash cannot be enumerated otherwise.
	$wpdb->prepare(
		"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_tendr_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_tendr_' ) . '%'
	)
);
foreach ( (array) $tendr_names as $tendr_name ) {
	delete_option( $tendr_name );
}
