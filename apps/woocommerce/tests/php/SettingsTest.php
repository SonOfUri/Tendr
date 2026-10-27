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

	public function set_up(): void {
		parent::set_up();
		// The connected page reads the store's status and settings; here tendr is down.
		$this->mock_http( fn() => self::response( 503, null ) );
	}

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
		// C2: Disconnect posts the form with its own nonce; no GET link can disconnect.
		$this->assertMatchesRegularExpression( '/<button[^>]*formmethod="post"[^>]*action=tendr_disconnect[^>]*data-tendr-disconnect/', $html );
		$this->assertStringContainsString( 'name="tendr_disconnect_nonce"', $html );
		$this->assertStringNotContainsString( '_wpnonce', $html );
	}

	public function test_a_site_wide_notice_says_test_mode_to_store_managers(): void {
		self::connect_locally();
		$this->assertSame( '', Tendr_Settings::admin_notices_html(), 'guests see nothing' );
		$customer = self::factory()->user->create( array( 'role' => 'customer' ) );
		wp_set_current_user( $customer );
		$this->assertSame( '', Tendr_Settings::admin_notices_html(), 'customers see nothing' );

		$this->login_admin();
		$html = Tendr_Settings::admin_notices_html();
		$this->assertStringContainsString( 'tendr is in test mode', $html );
		$this->assertStringContainsString( esc_url( Tendr_Settings::url() ), $html );

		update_option( 'tendr_mode', 'live' );
		$this->assertSame( '', Tendr_Settings::admin_notices_html(), 'live mode' );
		update_option( 'tendr_mode', 'test' );
		delete_option( 'tendr_connection' );
		$this->assertSame( '', Tendr_Settings::admin_notices_html(), 'not connected' );
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
