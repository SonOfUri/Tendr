<?php
/**
 * The settings page (WooCommerce → Settings → Payments → tendr).
 *
 * @package Tendr
 */

/**
 * Tendr_Settings and Tendr_Gateway.
 */
class SettingsTest extends Tendr_Test_Case {

	public function test_not_connected_shows_the_connect_button(): void {
		$this->login_admin();
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Connect to tendr', $html );
		$this->assertStringContainsString( 'data-tendr-connect=', $html );
		$this->assertStringContainsString( 'action=tendr_connect_start', $html );
		$this->assertStringNotContainsString( 'disabled', $html );
		$this->assertStringNotContainsString( 'Disconnect', $html );
	}

	public function test_connected_shows_store_mode_and_disconnect(): void {
		$this->login_admin();
		self::connect_locally();
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Connected to', $html );
		$this->assertStringContainsString( 'Corner Shop a', $html );
		$this->assertStringContainsString( 'Test mode', $html );
		$this->assertStringContainsString( 'action=tendr_disconnect', $html );
		$this->assertStringNotContainsString( 'data-tendr-connect=', $html );
	}

	public function test_secrets_never_appear_in_settings_page_html(): void {
		$this->login_admin();
		$issued = self::connect_locally();
		$html   = Tendr_Settings::render();

		$gateway = new Tendr_Gateway();
		ob_start();
		$gateway->admin_options();
		$html .= (string) ob_get_clean();

		foreach ( self::secrets_of( $issued ) as $secret ) {
			$this->assertStringNotContainsString( $secret, $html );
		}
		$this->assertStringNotContainsString( 'tdr_test_', $html );
		$this->assertStringNotContainsString( 'tdr_live_', $html );
		$this->assertStringNotContainsString( 'whsec_', $html );
	}

	public function test_unreadable_credentials_ask_to_reconnect(): void {
		$this->login_admin();
		self::connect_locally();
		$other = sodium_crypto_generichash( 'rotated-salts', '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES );
		update_option( Tendr_Credentials::OPTION, Tendr_Credentials::seal( (string) wp_json_encode( self::issued() ), $other ), false );

		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Reconnect to tendr', $html );
		$this->assertStringContainsString( 'data-tendr-connect=', $html );
		$this->assertFalse( Tendr_Connect::is_connected() );
	}

	public function test_permalinks_off_blocks_connect_with_a_notice(): void {
		$this->set_permalink_structure( '' );
		$this->login_admin();
		$html = Tendr_Settings::render();
		$this->assertStringContainsString( 'Enable pretty permalinks to connect', $html );
		$this->assertStringContainsString( 'options-permalink.php', $html );
		$this->assertMatchesRegularExpression( '/<button[^>]*disabled/', $html );
		$this->assertStringNotContainsString( 'data-tendr-connect=', $html );
	}

	public function test_gateway_is_registered_and_hidden_from_guests_in_test_mode(): void {
		$gateways = WC()->payment_gateways()->payment_gateways();
		$this->assertArrayHasKey( 'tendr', $gateways );
		$this->assertInstanceOf( Tendr_Gateway::class, $gateways['tendr'] );
		self::connect_locally();
		$this->assertFalse( ( new Tendr_Gateway() )->is_available() );
	}

	public function test_settings_url_is_the_payments_section(): void {
		$this->assertSame( admin_url( 'admin.php?page=wc-settings&tab=checkout&section=tendr' ), Tendr_Settings::url() );
	}
}
