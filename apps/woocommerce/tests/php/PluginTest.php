<?php
/**
 * Bootstrap, requirements and compatibility.
 *
 * @package Tendr
 */

use Automattic\WooCommerce\Utilities\FeaturesUtil;

/**
 * Tendr_Plugin.
 */
class PluginTest extends Tendr_Test_Case {

	public function test_woocommerce_missing_is_a_requirement_error(): void {
		$error = Tendr_Plugin::requirement_error( '8.2.0', null );
		$this->assertIsString( $error );
		$this->assertStringContainsString( 'WooCommerce', $error );
	}

	public function test_old_woocommerce_or_php_is_a_requirement_error(): void {
		$this->assertStringContainsString( '8.5', (string) Tendr_Plugin::requirement_error( '8.2.0', '8.4.9' ) );
		$this->assertStringContainsString( 'PHP 8.0', (string) Tendr_Plugin::requirement_error( '7.4.33', '9.0.0' ) );
		$this->assertNull( Tendr_Plugin::requirement_error( '8.0.0', '8.5.0' ) );
		$this->assertNull( Tendr_Plugin::requirement_error( '8.2.0', WC_VERSION ) );
	}

	public function test_woocommerce_missing_notice_renders_and_nothing_else_boots(): void {
		$html = Tendr_Plugin::requirements_notice_html( (string) Tendr_Plugin::requirement_error( '8.2.0', null ) );
		$this->assertStringContainsString( 'notice notice-error', $html );
		$this->assertStringContainsString( 'WooCommerce', $html );

		// With WooCommerce missing, boot() only adds the notice.
		$hooks_before = has_filter( 'woocommerce_payment_gateways' );
		$booted       = Tendr_Plugin::boot( '8.2.0', null );
		$this->assertFalse( $booted );
		$this->assertSame( $hooks_before, has_filter( 'woocommerce_payment_gateways' ) );
		$this->assertNotFalse( has_action( 'admin_notices' ) );
	}

	public function test_hpos_and_blocks_compatibility_are_declared(): void {
		$plugin = plugin_basename( TENDR_PLUGIN_FILE );
		$this->assertContains( $plugin, FeaturesUtil::get_compatible_plugins_for_feature( 'custom_order_tables', true )['compatible'] );
		$this->assertContains( $plugin, FeaturesUtil::get_compatible_plugins_for_feature( 'cart_checkout_blocks', true )['compatible'] );
	}

	public function test_main_file_header(): void {
		$data = get_file_data(
			TENDR_PLUGIN_FILE,
			array(
				'name'    => 'Plugin Name',
				'version' => 'Version',
				'license' => 'License',
				'domain'  => 'Text Domain',
				'php'     => 'Requires PHP',
				'wc'      => 'WC requires at least',
			)
		);
		$this->assertSame( 'tendr: Pay with crypto', $data['name'] );
		$this->assertSame( TENDR_VERSION, $data['version'] );
		$this->assertSame( 'GPL-2.0-or-later', $data['license'] );
		$this->assertSame( 'tendr', $data['domain'] );
		$this->assertSame( '8.0', $data['php'] );
		$this->assertSame( '8.5', $data['wc'] );
	}

	public function test_api_app_and_checkout_base_defaults(): void {
		$this->assertSame( 'https://api.usetendr.tech', Tendr_Plugin::api_base() );
		$this->assertSame( 'https://pay.usetendr.tech', Tendr_Plugin::checkout_base() );
		$this->assertSame( 'https://app.usetendr.tech', Tendr_Plugin::app_base() );
	}

	/**
	 * @runInSeparateProcess
	 * @preserveGlobalState disabled
	 */
	public function test_tendr_app_base_constant_overrides_the_app_base(): void {
		define( 'TENDR_APP_BASE', 'https://app.example.test/' );
		$this->assertSame( 'https://app.example.test', Tendr_Plugin::app_base() );
		$this->assertSame( 'https://pay.usetendr.tech', Tendr_Plugin::checkout_base() );
	}

	public function test_uninstall_removes_options_and_transients(): void {
		self::connect_locally();
		update_option( 'tendr_mode', 'test' );
		set_transient( 'tendr_connect_abc', array( 'verifier' => 'x' ), HOUR_IN_SECONDS );

		if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
			define( 'WP_UNINSTALL_PLUGIN', plugin_basename( TENDR_PLUGIN_FILE ) );
		}
		include TENDR_PLUGIN_DIR . 'uninstall.php';

		$this->assertFalse( get_option( Tendr_Credentials::OPTION ) );
		$this->assertFalse( get_option( 'tendr_connection' ) );
		$this->assertFalse( get_option( 'tendr_mode' ) );
		$this->assertFalse( get_option( 'woocommerce_tendr_settings' ) );
		$this->assertFalse( get_transient( 'tendr_connect_abc' ) );
	}
}
